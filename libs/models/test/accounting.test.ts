import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { natsFixture } from '@opencrane/event-store/testing';
import { wireSubject } from '@opencrane/event-store';
import { jetstream } from '@nats-io/jetstream';
import { createLogger } from '@opencrane/observability';
import { ProjectionRunner, type Query } from '@opencrane/projections';
import { database } from '@opencrane/projections/testing';
import { BudgetActor, envelope } from '../src/actor.ts';
import { data, priceTableId, totals } from '../src/state.ts';
import { budgets, readSpendingEffects, readCurrentEffects } from '../src/accounting.ts';
import { initialiseBudgetProjection, rebuildBudgetProjection } from '../src/rebuild.ts';
import * as models from '../src/index.ts';

let nats: Awaited<ReturnType<typeof natsFixture>>;
let postgres: Awaited<ReturnType<typeof database>>;
let actor: BudgetActor;
let runner: ProjectionRunner;
let clock: Date;
const logger = createLogger('accounting-test', { level: 'silent' });
function now() { return clock; }
function call(payingGroupId = 'sales', assistantId = 'sales-assistant') {
  return { model: 'gpt-6-luna', priceTableId, payingGroupId, assistantId,
    computerId: 'computer', requesterId: 'alice', conversationId: 'conversation',
    turnId: 'turn', threadId: 'thread', contextDigest: '0'.repeat(64) };
}
async function seed(subject: string, type: string, payload: unknown, silo = 'test') {
  const saved = envelope(silo, subject, type, payload);
  await nats.seed([saved]);
}
async function initialise() {
  nats = await natsFixture();
  postgres = await database('pg');
  clock = new Date('2026-10-31T23:59:00.000Z');
  for (const group of ['sales', 'support']) {
    await seed(`team-${group}`, 'team.created',
      { teamId: group, name: group, createdBy: 'alice' });
    await seed(`assistant-${group}-assistant`, 'assistant.created',
      { assistantId: `${group}-assistant`, ownerId: group, kind: 'team', payingGroupId: group });
  }
  actor = new BudgetActor(nats.store, 'test', now);
  await actor.start(20_000, 20_000, 'sales');
  runner = new ProjectionRunner(postgres.db, nats.reader, logger);
  await initialiseBudgetProjection(postgres.db, nats.reader, logger);
}
async function close() {
  await postgres?.close();
  await nats?.close();
}
beforeEach(initialise);
afterEach(close);

async function allPages(filters: { payingGroupId?: string; assistantId?: string; month?: string } = {},
  db: Query = postgres.db) {
  const rows: models.SpendingCall[] = [];
  let after = 0;
  for (let page = 0; page < 150; page += 1) {
    const result = await models.readSpendingCalls(db, 'test', { ...filters, after, limit: 2 });
    expect(result.rows.length).toBeLessThanOrEqual(2);
    rows.push(...result.rows);
    if (result.next === null) return rows;
    expect(result.next).toBeGreaterThan(after);
    after = result.next;
  }
  throw new Error('Paging did not finish');
}
function reservationId(row: models.SpendingCall) { return row.reservationId; }

async function pagesMixedCalls() {
  const sales: string[] = [];
  const shared: string[] = [];
  for (let index = 0; index < 71; index += 1) {
    sales.push(await actor.reserve(call(), 120));
    shared.push(await actor.reserve(call('support', 'sales-assistant'), 30));
    await actor.reserve(call('support', 'support-assistant'), 60);
  }
  const other = new BudgetActor(nats.store, 'foreign', now);
  await other.start(1000, 1000, 'sales');
  await other.reserve(call(), 99);
  await runner.run(budgets);
  const all = await allPages();
  const ids = all.map(reservationId);
  expect(new Set(ids).size).toBe(213);
  expect(all).toHaveLength(213);
  for (const row of all) expect(row.silo).toBe('test');
  const payerRows = await allPages({ payingGroupId: 'sales' });
  expect(payerRows.map(reservationId)).toEqual(sales);
  const assistantRows = await allPages({ assistantId: 'sales-assistant' });
  expect(assistantRows).toHaveLength(142);
  const combined = await allPages({ payingGroupId: 'support', assistantId: 'sales-assistant' });
  expect(combined.map(reservationId)).toEqual(shared);
  expect(await allPages({ payingGroupId: 'absent' })).toEqual([]);
  const defaultPage = await models.readSpendingCalls(postgres.db, 'test');
  expect(defaultPage.rows).toHaveLength(20);
  const rebuilt = await rebuildBudgetProjection(postgres.db, nats.reader, logger, { verify: true });
  expect(rebuilt.changed).toBe(false);
  expect(await allPages()).toEqual(all);
  await expect(models.readSpendingCalls(postgres.db, 'test', { limit: 51 })).rejects.toThrow();
  await expect(models.readSpendingCalls(postgres.db, 'test', { after: -1 })).rejects.toThrow();
}
it('pages real payers and assistants across mixed data without duplicates or foreign rows',
  pagesMixedCalls);

async function settle(id: string, cents: number) {
  const evidence = [{ kind: 'provider_receipt', reference: 'receipt',
    digest: '0'.repeat(64), amountCents: cents }];
  const payload = { reservationId: id, permitId: id, settledCents: cents,
    outcome: 'settled', resolvedBy: 'owner', evidence };
  const original = envelope('test', `effect-${id}`, 'effect.resolved', payload);
  const saved = { ...original, source: 'opencrane-server',
    principal: { kind: 'human' as const, id: 'owner' } };
  await nats.seed([saved]);
  await actor.settleRecorded(id, saved.id);
  return saved.id;
}
async function keepsOriginalMoney() {
  const oldHold = await actor.reserve(call(), 120);
  const late = await actor.reserve(call('support', 'support-assistant'), 100);
  const conflict = await actor.reserve(call(), 120);
  await runner.run(budgets);
  const initial = await allPages();
  clock = new Date('2026-11-01T00:01:00.000Z');
  actor = new BudgetActor(nats.store, 'test', now);
  await actor.start();
  await actor.configure({ scope: 'global', ceilingCents: 20_000, setBy: 'owner',
    defaultPayingGroupId: 'support' });
  const receipt = await settle(late, 70);
  await settle(conflict, 80);
  await settle(conflict, 180);
  await runner.run(budgets);
  const before = await allPages();
  for (let index = 0; index < before.length; index += 1) {
    expect(before[index]?.position).toBe(initial[index]?.position);
  }
  const position = await nats.store.head();
  await actor.settleRecorded(late, receipt);
  expect(await nats.store.head()).toBe(position);
  await runner.run(budgets);
  expect(await allPages()).toEqual(before);
  expect(await allPages({ month: '2026-10' })).toEqual(before);
  expect(await allPages({ month: '2026-11' })).toEqual([]);
  expect(before).toMatchObject([
    { reservationId: oldHold, permitId: oldHold, payingGroupId: 'sales',
      heldCents: 120, settledCents: null, evidence: 'held', day: '2026-10-31', month: '2026-10' },
    { reservationId: late, payingGroupId: 'support', assistantId: 'support-assistant',
      heldCents: 0, settledCents: 70, evidence: 'settled', month: '2026-10' },
    { reservationId: conflict, heldCents: 120, settledCents: 180, evidence: 'unknown' },
  ]);
  let held = 0;
  let settled = 0;
  for (const row of before) {
    held += row.heldCents;
    settled += row.settledCents ?? 0;
  }
  expect({ held, settled }).toEqual({ held: 240, settled: 250 });
  expect(totals(actor.state, clock)).toMatchObject({ reservedCents: held, monthCents: 0 });
  expect(totals(actor.state, new Date('2026-10-31'))).toMatchObject({ monthCents: settled });
  const actorBefore = structuredClone(actor.state);
  const result = await rebuildBudgetProjection(postgres.db, nats.reader, logger, { verify: true });
  expect(result.changed).toBe(false);
  expect(await allPages()).toEqual(before);
  expect(await nats.store.head()).toBe(position);
  expect(actor.state).toEqual(actorBefore);
}
it('keeps old holds and original late charges, preserves conflicting money and replays without effects',
  keepsOriginalMoney);

async function upgradesInstalledRows() {
  await actor.reserve(call(), 120);
  await runner.run(budgets);
  const before = await allPages();
  await postgres.db.query('DROP TABLE model_budget_calls');
  await postgres.db.query('UPDATE projection_versions SET version = 2 WHERE name = $1',
    [budgets.name]);
  await expect(models.readSpendingCalls(postgres.db, 'test')).rejects.toThrow();
  const position = await nats.store.head();
  await initialiseBudgetProjection(postgres.db, nats.reader, logger);
  expect(await allPages()).toEqual(before);
  expect(await nats.store.head()).toBe(position);
  await postgres.db.query('DELETE FROM model_budget_calls');
  await expect(rebuildBudgetProjection(postgres.db, nats.reader, logger, { verify: true }))
    .rejects.toThrow('differs');
  await rebuildBudgetProjection(postgres.db, nats.reader, logger);
  expect(await allPages()).toEqual(before);
}
it('upgrades installed budgets and verifies call rows as well as existing totals', upgradesInstalledRows);

async function refusesMissingLegacyAttribution() {
  await seed('budget-test', 'budget.reserved',
    { reservationId: 'legacy', permitId: 'legacy', amountCents: 120,
      payingGroupId: 'sales', assistantId: 'sales-assistant' });
  await postgres.db.query('UPDATE projection_versions SET version = 2 WHERE name = $1',
    [budgets.name]);
  await expect(initialiseBudgetProjection(postgres.db, nats.reader, logger)).rejects.toThrow();
  await expect(models.readSpendingCalls(postgres.db, 'test')).rejects.toThrow();
}
it('keeps incomplete legacy history unavailable rather than inventing call attribution',
  refusesMissingLegacyAttribution);

async function boundedReads() {
  await actor.reserve(call(), 120);
  await runner.run(budgets);
  // Deny access to the old JSON table and retain only the read port.
  await postgres.db.query('ALTER TABLE model_budgets RENAME TO inaccessible_budgets');
  const statements: string[] = [];
  async function query<Row extends Record<string, unknown>>(sql: string, parameters?: unknown[],
    options?: { deadline: number }) {
    statements.push(sql);
    expect(options?.deadline).toBeGreaterThan(performance.now());
    return postgres.db.query<Row>(sql, parameters, options);
  }
  expect(await allPages({}, { query })).toHaveLength(1);
  expect(statements).toHaveLength(2);
  expect(statements[1]).toContain('LIMIT');
  await postgres.db.query('SET enable_seqscan = off');
  const plan = await postgres.db.query(`EXPLAIN SELECT position FROM model_budget_calls
    WHERE silo = $1 AND paying_group_id = $2 AND assistant_id = $3 AND position > $4
    ORDER BY position LIMIT 3`, ['test', 'sales', 'sales-assistant', 0]);
  expect(JSON.stringify(plan.rows)).toContain('Index');
  expect(JSON.stringify(plan.rows)).not.toContain('Sort');
}
it('reads only bounded indexed rows with a database deadline and no event history', boundedReads);

async function boundsLockedReads() {
  let release = () => {};
  let acquired = () => {};
  function holdLock(resolve: () => void) { release = resolve; }
  function markAcquired(resolve: () => void) { acquired = resolve; }
  const held = new Promise<void>(holdLock);
  const ready = new Promise<void>(markAcquired);
  async function lock(tx: Query) {
    await tx.query('LOCK TABLE model_budget_calls IN ACCESS EXCLUSIVE MODE');
    acquired();
    await held;
  }
  const locked = postgres.db.transaction(lock);
  await ready;
  try {
    const read = models.readSpendingCalls(postgres.db, 'test',
      { month: '2026-10' }, performance.now() + 150);
    const watchdog = delay(3000, 'read did not expire');
    await expect(Promise.race([read, watchdog])).rejects.toThrow('Database read expired');
  } finally {
    release();
    await locked;
  }
  expect(await allPages()).toEqual([]);
}
it('expires a blocked database read while the lock remains held and recovers afterwards',
  boundsLockedReads);

async function upgradesMonthSelection() {
  await actor.reserve(call(), 120);
  clock = new Date('2026-11-01T00:00:00.000Z');
  await actor.reserve(call('support', 'support-assistant'), 70);
  await runner.run(budgets);
  const before = await allPages();
  await postgres.db.query(`DROP INDEX model_budget_calls_month, model_budget_calls_month_payer,
    model_budget_calls_month_assistant, model_budget_calls_month_scopes`);
  await postgres.db.query('UPDATE projection_versions SET version = 3 WHERE name = $1',
    [budgets.name]);
  await expect(models.readSpendingCalls(postgres.db, 'test')).rejects.toThrow('unavailable');
  const position = await nats.store.head();
  await initialiseBudgetProjection(postgres.db, nats.reader, logger);
  expect(await allPages()).toEqual(before);
  expect(await allPages({ month: '2026-10' })).toEqual([before[0]]);
  expect(await allPages({ month: '2026-11' })).toEqual([before[1]]);
  await rebuildBudgetProjection(postgres.db, nats.reader, logger, { verify: true });
  expect(await allPages()).toEqual(before);
  expect(await nats.store.head()).toBe(position);
}
it('upgrades installed call rows for month selection without changing their order',
  upgradesMonthSelection);

async function indexedMonthReads() {
  await actor.reserve(call(), 120);
  await runner.run(budgets);
  await postgres.db.query('ALTER TABLE model_budgets RENAME TO inaccessible_budgets');
  await postgres.db.query('SET enable_seqscan = off');
  for (const filters of [{}, { payingGroupId: 'sales' }, { assistantId: 'sales-assistant' },
    { payingGroupId: 'sales', assistantId: 'sales-assistant' }]) {
    async function query<Row extends Record<string, unknown>>(sql: string, values?: unknown[],
      options?: { deadline: number }) {
      expect(options?.deadline).toBeGreaterThan(performance.now());
      if (sql.includes('FROM model_budget_calls')) {
        expect(values?.at(-1)).toBe(3);
        const plan = await postgres.db.query(`EXPLAIN ${sql}`, values);
        const details = JSON.stringify(plan.rows);
        expect(details).toContain('Index Cond');
        expect(details).toContain('2026-10');
        expect(details).not.toContain('Filter:');
        expect(details).not.toContain('Sort');
      }
      return postgres.db.query<Row>(sql, values, options);
    }
    expect(await allPages({ ...filters, month: '2026-10' }, { query })).toHaveLength(1);
  }
}
it('selects each month and scope combination through an ordered index without scanning other rows',
  indexedMonthReads);

function effectEvent(index: number, permitId = 'permit', silo = 'test') {
  const observed = { permitId, computerId: 'private-computer', tool: 'private-tool',
    destination: 'private-destination', costCents: index, outcome: 'success',
    usage: { inputTokens: 100, outputTokens: 10, priceTableId: 'private-tariff' } };
  let type = 'effect.observed';
  let payload: unknown = observed;
  if (index % 3 === 1) {
    type = 'effect.uncertain';
    payload = { permitId, computerId: 'private-computer', reason: 'missing_usage' };
  } else if (index % 3 === 2) {
    type = 'effect.resolved';
    payload = { permitId, reservationId: permitId, resolvedBy: 'owner',
      outcome: 'settled', settledCents: 0, evidence: [{ kind: 'provider_receipt',
        reference: 'private-receipt', digest: '0'.repeat(64), amountCents: 0 }] };
  }
  const saved = envelope(silo, `effect-${permitId}`, type, payload);
  return { ...saved, source: 'opencrane-server',
    principal: { kind: 'human' as const, id: 'owner' } };
}
async function effectPages(permitId?: string) {
  const rows = [];
  let after = 0;
  while (true) {
    const page = await readSpendingEffects(postgres.db, 'test', { permitId, after, limit: 50 });
    expect(page.rows.length).toBeLessThanOrEqual(50);
    rows.push(...page.rows);
    if (page.next === null) return rows;
    expect(page.next).toBeGreaterThan(after);
    after = page.next;
  }
}
async function pagesSavedEffects(mode: 'verify' | 'replace') {
  const expectedIds: string[] = [];
  const permitIds: string[] = [];
  for (let index = 0; index < 213; index += 1) {
    const permitId = index % 2 === 0 ? 'permit' : 'other-permit';
    const saved = effectEvent(index, permitId);
    await nats.seed([saved, effectEvent(index, permitId, 'foreign')]);
    expectedIds.push(saved.id);
    if (permitId === 'permit') permitIds.push(saved.id);
  }
  await runner.run(budgets);
  const all = await effectPages();
  function eventId(row: { eventId: string }) { return row.eventId; }
  expect(all.map(eventId)).toEqual(expectedIds);
  const filtered = await effectPages('permit');
  expect(filtered.map(eventId)).toEqual(permitIds);
  expect(await effectPages('absent')).toEqual([]);
  const first = await readSpendingEffects(postgres.db, 'test');
  expect(first.rows).toHaveLength(20);
  expect(first.next).toBe(all[19]?.position);
  expect(first.sequence).toBe(await nats.store.head());
  expect(first.generation).toBeGreaterThanOrEqual(0);
  expect(all.slice(0, 3)).toMatchObject([
    { type: 'effect.observed', outcome: 'success', costCents: 0,
      settledCents: null, resolvedBy: null, changeRef: null },
    { type: 'effect.uncertain', outcome: null, costCents: null, settledCents: null },
    { type: 'effect.resolved', outcome: 'settled', costCents: null,
      settledCents: 0, resolvedBy: 'owner' },
  ]);
  expect(JSON.stringify(all)).not.toContain('private-');
  await expect(readSpendingEffects(postgres.db, 'test', { limit: 51 })).rejects.toThrow();
  await expect(readSpendingEffects(postgres.db, 'test', { after: -1 })).rejects.toThrow();
  await verifiesEffectReplay(all, mode);
}
it.each(['verify', 'replace'] as const)(
  'pages mixed saved effect records without private or foreign data and can %s them',
  pagesSavedEffects, 60_000);

async function accountingStorage() {
  const result = await postgres.db.query(`SELECT
    (SELECT jsonb_agg(row_data ORDER BY silo) FROM model_budgets row_data) AS budgets,
    (SELECT jsonb_agg(row_data ORDER BY silo, reservation_id)
      FROM model_budget_calls row_data) AS calls,
    (SELECT jsonb_agg(row_data ORDER BY event_id) FROM projection_events row_data
      WHERE projection = 'model-budgets') AS receipts,
    (SELECT sequence FROM projection_checkpoints WHERE name = 'model-budgets') AS checkpoint,
    (SELECT jsonb_agg(ROW(oid, relname, relacl) ORDER BY relname) FROM pg_class
      WHERE relname IN ('model_budgets', 'model_budget_calls', 'model_budget_effects',
        'model_current_effects')) AS grants`);
  return result.rows;
}
async function verifiesEffectReplay(all: Awaited<ReturnType<typeof effectPages>>,
  mode: 'verify' | 'replace') {
  await postgres.db.query(`GRANT SELECT ON model_budgets, model_budget_calls,
    model_budget_effects TO PUBLIC`);
  const before = await accountingStorage();
  const actorBefore = structuredClone(actor.state);
  const head = await nats.store.head();
  const page = await readSpendingEffects(postgres.db, 'test');
  if (mode === 'verify') {
    await rebuildBudgetProjection(postgres.db, nats.reader, logger, { verify: true });
    expect(await effectPages()).toEqual(all);
    expect(await accountingStorage()).toEqual(before);
  }
  // Corrupt a test-silo record after the 213 foreign-silo records in verification order.
  await postgres.db.query('UPDATE model_budget_effects SET cost_cents = 999 WHERE event_id = $1',
    [all.at(-1)!.eventId]);
  if (mode === 'verify') {
    await expect(rebuildBudgetProjection(postgres.db, nats.reader, logger, { verify: true }))
      .rejects.toThrow('differs');
    expect(await accountingStorage()).toEqual(before);
  } else {
    await rebuildBudgetProjection(postgres.db, nats.reader, logger);
    expect(await effectPages()).toEqual(all);
    const repaired = await readSpendingEffects(postgres.db, 'test');
    expect(repaired.generation).toBe(page.generation + 1);
    await postgres.db.query('TRUNCATE model_budget_effects');
    await postgres.db.query('UPDATE projection_versions SET version = 4 WHERE name = $1',
      [budgets.name]);
    await expect(readSpendingEffects(postgres.db, 'test')).rejects.toThrow('unavailable');
    await initialiseBudgetProjection(postgres.db, nats.reader, logger);
    expect(await effectPages()).toEqual(all);
    expect(await accountingStorage()).toEqual(before);
  }
  expect(await nats.store.head()).toBe(head);
  expect(actor.state).toEqual(actorBefore);
}

async function preservesSeparateEvidence() {
  const permitId = await actor.reserve(call(), 120);
  clock = new Date('2026-11-01T00:01:00.000Z');
  const resolution = effectEvent(2, permitId);
  const saved = { ...resolution, time: '2026-11-01T01:01:00+01:00' };
  await nats.seed([saved]);
  await runner.run(budgets);
  const resolved = await effectPages(permitId);
  expect(resolved).toMatchObject([{ eventId: saved.id, time: saved.time,
    type: 'effect.resolved', settledCents: 0, changeRef: saved.commandId, resolvedBy: 'owner' }]);
  const calls = await allPages();
  expect(calls).toMatchObject([{ month: '2026-10', heldCents: 120, settledCents: null }]);
  const first = effectEvent(0, permitId);
  const conflict = effectEvent(3, permitId);
  await nats.seed([first, conflict]);
  await runner.run(budgets);
  const before = await effectPages(permitId);
  expect(before).toHaveLength(3);
  expect(before.slice(1)).toMatchObject([{ costCents: 0 }, { costCents: 3 }]);
  // Deliver the same event again without the transport's temporary deduplication key.
  const stream = jetstream(nats.connection);
  await stream.publish(wireSubject(first.subject), JSON.stringify(first));
  await runner.run(budgets);
  expect(await effectPages(permitId)).toEqual(before);
  expect(await allPages()).toEqual(calls);
  const head = await nats.store.head();
  const actorBefore = structuredClone(actor.state);
  await rebuildBudgetProjection(postgres.db, nats.reader, logger, { verify: true });
  expect(await effectPages(permitId)).toEqual(before);
  expect(await allPages()).toEqual(calls);
  expect(await nats.store.head()).toBe(head);
  expect(actor.state).toEqual(actorBefore);
}
it('keeps duplicate and conflicting evidence distinct from settlement and the original month hold',
  preservesSeparateEvidence);

async function verifiesResolverIdentity() {
  const valid = effectEvent(2);
  const validData = data(valid);
  const wrongReservation = { ...effectEvent(2), data: {
    ...validData, reservationId: 'another-permit' } };
  const records = [valid, { ...effectEvent(2), source: 'computer' },
    { ...effectEvent(2), principal: { kind: 'human' as const, id: 'another-person' } },
    { ...effectEvent(2), principal: { kind: 'system' as const, id: 'owner' } },
    { ...effectEvent(2), subject: 'effect-another-permit' }, wrongReservation];
  await nats.seed(records);
  await runner.run(budgets);
  const rows = await effectPages();
  expect(rows[0]).toMatchObject({ resolvedBy: 'owner', changeRef: valid.commandId });
  for (const row of rows.slice(1)) {
    expect(row).toMatchObject({ resolvedBy: null, changeRef: null });
  }
}
it('exposes resolver details only for the matching server, human and permit binding',
  verifiesResolverIdentity);

async function boundedEffectReads() {
  await nats.seed([effectEvent(0)]);
  await runner.run(budgets);
  await postgres.db.query('ALTER TABLE model_budgets RENAME TO inaccessible_budgets');
  await postgres.db.query('ALTER TABLE model_budget_calls RENAME TO inaccessible_calls');
  async function checkIndexes(tx: Query) {
    await tx.query('SET LOCAL enable_seqscan = off');
    for (const permitId of [undefined, 'permit']) {
      const deadline = performance.now() + 2000;
      const statements: string[] = [];
      async function query<Row extends Record<string, unknown>>(sql: string, values?: unknown[],
        options?: { deadline: number }) {
        statements.push(sql);
        expect(options?.deadline).toBe(deadline);
        if (sql.includes('FROM model_budget_effects')) {
          expect(values?.at(-1)).toBe(51);
          const plan = await tx.query(`EXPLAIN ${sql}`, values);
          const details = JSON.stringify(plan.rows);
          expect(details).toContain('Index Cond');
          expect(details).not.toContain('Filter:');
          expect(details).not.toContain('Sort');
        }
        return tx.query<Row>(sql, values, options);
      }
      const result = await readSpendingEffects({ query }, 'test', { permitId, limit: 50 }, deadline);
      expect(result.rows).toHaveLength(1);
      expect(statements).toHaveLength(2);
    }
  }
  await postgres.db.transaction(checkIndexes);
}
it('reads effects through bounded ordered indexes without budget JSON, calls or stream scans',
  boundedEffectReads);

async function refusesUnavailableEffects(table: string) {
  let read: (db: Query, silo: string, input?: object, deadline?: number) => Promise<unknown>
    = readSpendingEffects;
  function readCurrent(db: Query, silo: string, _input?: object, deadline?: number) {
    return readCurrentEffects(db, silo, 0, {}, deadline);
  }
  if (table === 'model_current_effects') read = readCurrent;
  let release = () => {};
  let acquired = () => {};
  function holdLock(resolve: () => void) { release = resolve; }
  function markAcquired(resolve: () => void) { acquired = resolve; }
  const held = new Promise<void>(holdLock);
  const ready = new Promise<void>(markAcquired);
  async function lock(tx: Query) {
    await tx.query(`LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE`);
    acquired();
    await held;
  }
  const locked = postgres.db.transaction(lock);
  await ready;
  try {
    const pending = read(postgres.db, 'test', {}, performance.now() + 150);
    await expect(Promise.race([pending, delay(3000, 'read did not expire')]))
      .rejects.toThrow('Database read expired');
  } finally {
    release();
    await locked;
  }
  expect(await effectPages()).toEqual([]);
  await postgres.db.query('DELETE FROM projection_checkpoints WHERE name = $1', [budgets.name]);
  await expect(read(postgres.db, 'test')).rejects.toThrow('unavailable');
  await runner.initialise(budgets);
  await postgres.db.query(`DROP TABLE ${table}`);
  await expect(read(postgres.db, 'test')).rejects.toThrow();
  await expect(read(postgres.db, 'test', {}, performance.now() - 1))
    .rejects.toThrow('Database read expired');
}
it.each(['model_budget_effects', 'model_current_effects'])(
  'refuses missing or locked %s within the read deadline', refusesUnavailableEffects);

async function rollsBackFailedReplacement() {
  await actor.reserve(call(), 120);
  await nats.seed([effectEvent(1)]);
  await runner.run(budgets);
  const before = await accountingStorage();
  const page = await readSpendingEffects(postgres.db, 'test');
  await actor.reserve(call(), 70);
  await nats.seed([effectEvent(3)]);
  await postgres.db.query(`ALTER TABLE model_budget_effects
    ADD CONSTRAINT refuse_new_observation CHECK (cost_cents IS NULL)`);
  const actorBefore = structuredClone(actor.state);
  const head = await nats.store.head();
  await expect(rebuildBudgetProjection(postgres.db, nats.reader, logger)).rejects.toThrow();
  expect(await accountingStorage()).toEqual(before);
  expect(await readSpendingEffects(postgres.db, 'test')).toEqual(page);
  await postgres.db.query('ALTER TABLE model_budget_effects DROP CONSTRAINT refuse_new_observation');
  await rebuildBudgetProjection(postgres.db, nats.reader, logger);
  const rebuilt = await readSpendingEffects(postgres.db, 'test');
  expect(rebuilt.rows).toHaveLength(2);
  expect(rebuilt.sequence).toBe(head);
  expect(await allPages()).toHaveLength(2);
  expect(await nats.store.head()).toBe(head);
  expect(actor.state).toEqual(actorBefore);
}
it('rolls back rows, receipts and checkpoint together when replacement fails',
  rollsBackFailedReplacement);

async function currentPage() {
  const sequence = await nats.store.head();
  return readCurrentEffects(postgres.db, 'test', sequence);
}
async function matchesCurrentEffectRules() {
  const oldHold = await actor.reserve(call(), 120);
  const released = await actor.reserve(call('support', 'support-assistant'), 100);
  const late = await actor.reserve(call(), 110);
  const disputed = await actor.reserve(call(), 120);
  await runner.run(budgets);
  const initial = await currentPage();
  clock = new Date('2026-11-01T00:01:00.000Z');
  const original = effectEvent(2, released);
  const resolution = { ...original, data: { ...data(original), outcome: 'released',
    evidence: [{ kind: 'dispatch_record', reference: 'private-unsent',
      digest: '0'.repeat(64), notDispatched: true }] } };
  await nats.seed([resolution, effectEvent(1, oldHold)]);
  await runner.run(budgets);
  const pending = (await currentPage()).rows[1];
  const detail = await models.readEffect(nats.store, 'test', released);
  expect(pending).toMatchObject({ state: detail!.state, effectPosition: detail!.sequence });
  expect(pending).toMatchObject({ state: 'resolution_pending', heldCents: 100, settledCents: null });
  await actor.settleRecorded(released, resolution.id);
  await settle(late, 70);
  const first = effectEvent(0, disputed);
  const conflicting = effectEvent(3, disputed);
  await nats.seed([first, conflicting]);
  await settle(disputed, 3);
  await runner.run(budgets);
  const result = await currentPage();
  expect(result.rows).toMatchObject([
    { permitId: oldHold, payingGroupId: 'sales', assistantId: 'sales-assistant',
      state: 'outcome_unknown', heldCents: 120, settledCents: null },
    { permitId: released, payingGroupId: 'support', assistantId: 'support-assistant',
      state: 'released', heldCents: 0, settledCents: 0 },
    { permitId: late, state: 'settled', heldCents: 0, settledCents: 70 },
    { permitId: disputed, state: 'outcome_unknown', conflict: true,
      heldCents: 120, settledCents: 3 },
  ]);
  for (let index = 0; index < result.rows.length; index += 1) {
    const row = result.rows[index]!;
    const detail = await models.readEffect(nats.store, 'test', row.permitId);
    expect(row).toMatchObject({ state: detail!.state, conflict: detail!.conflict,
      settledCents: detail!.settledCents, effectPosition: detail!.sequence });
    expect(row.position).toBe(initial.rows[index]!.position);
    expect(row.reservedAt).toBe('2026-10-31T23:59:00.000Z');
    expect(row.budgetPosition).toBeGreaterThanOrEqual(row.position);
  }
  expect(JSON.stringify(result)).not.toContain('private-');
  const stream = jetstream(nats.connection);
  await stream.publish(wireSubject(first.subject), JSON.stringify(first));
  await runner.run(budgets);
  expect((await currentPage()).rows).toEqual(result.rows);
  await nats.seed([effectEvent(1, late)]);
  await runner.run(budgets);
  const updated = await currentPage();
  expect(updated.rows[0]).toEqual(result.rows[0]);
  expect(updated.rows[1]).toEqual(result.rows[1]);
  expect(updated.rows[3]).toEqual(result.rows[3]);
  expect(updated.rows[2]).toMatchObject({ ...result.rows[2],
    effectPosition: await nats.store.head() });
}
it('matches current effect rules while keeping original attribution and exact held cents',
  matchesCurrentEffectRules);

async function currentPages() {
  const rows = [];
  const sequence = await nats.store.head();
  let after = 0;
  while (true) {
    const page = await readCurrentEffects(postgres.db, 'test', sequence, { after, limit: 50 });
    expect(page.rows.length).toBeLessThanOrEqual(50);
    rows.push(...page.rows);
    if (page.next === null) return rows;
    expect(page.next).toBeGreaterThan(after);
    after = page.next;
  }
}
async function pagesAndRebuildsCurrentEffects() {
  const expected: string[] = [];
  for (let index = 0; index < 205; index += 1) {
    const permitId = `permit-${String(index).padStart(3, '0')}`;
    expected.push(permitId);
    const payload = { reservationId: permitId, permitId, amountCents: 120,
      payingGroupId: 'sales', assistantId: 'sales-assistant', modelCall: call() };
    await seed('budget-test', 'budget.reserved', payload);
    if (index < 2) await seed('budget-foreign', 'budget.reserved', payload, 'foreign');
  }
  await runner.run(budgets);
  const rows = await currentPages();
  function permitId(row: { permitId: string }) { return row.permitId; }
  expect(rows.map(permitId)).toEqual(expected);
  for (const row of rows) expect(row.silo).toBe('test');
  const first = await currentPage();
  expect(first.rows).toHaveLength(20);
  expect(first.next).toBe(rows[19]!.position);
  expect(first.sequence).toBe(await nats.store.head());
  await postgres.db.query('GRANT SELECT ON model_current_effects TO PUBLIC');
  const before = await accountingStorage();
  const head = await nats.store.head();
  const actorBefore = structuredClone(actor.state);
  await rebuildBudgetProjection(postgres.db, nats.reader, logger, { verify: true });
  expect(await currentPages()).toEqual(rows);
  expect(await accountingStorage()).toEqual(before);
  await postgres.db.query(`UPDATE model_current_effects
    SET data = jsonb_set(data, '{heldCents}', '999') WHERE silo = 'test' AND permit_id = $1`,
  [expected.at(-1)]);
  await expect(rebuildBudgetProjection(postgres.db, nats.reader, logger, { verify: true }))
    .rejects.toThrow('differs');
  await rebuildBudgetProjection(postgres.db, nats.reader, logger);
  expect(await currentPages()).toEqual(rows);
  expect((await currentPage()).generation).toBe(first.generation + 1);
  expect(await accountingStorage()).toEqual(before);
  await postgres.db.query('DROP TABLE model_current_effects');
  await postgres.db.query('UPDATE projection_versions SET version = 5 WHERE name = $1',
    [budgets.name]);
  await expect(currentPage()).rejects.toThrow('unavailable');
  await initialiseBudgetProjection(postgres.db, nats.reader, logger);
  expect(await currentPages()).toEqual(rows);
  expect(await nats.store.head()).toBe(head);
  expect(actor.state).toEqual(actorBefore);
}
it('pages current effects and repairs corruption after 200 rows, then upgrades installed data',
  pagesAndRebuildsCurrentEffects, 60_000);

async function boundsCurrentReads() {
  await actor.reserve(call(), 120);
  await runner.run(budgets);
  const sequence = await nats.store.head();
  await postgres.db.query('ALTER TABLE model_budgets RENAME TO inaccessible_budgets');
  await postgres.db.query('ALTER TABLE model_budget_effects RENAME TO inaccessible_effects');
  await postgres.db.query('ALTER TABLE model_budget_calls RENAME TO inaccessible_calls');
  async function checkIndex(tx: Query) {
    await tx.query('SET LOCAL enable_seqscan = off');
    const deadline = performance.now() + 2000;
    async function query<Row extends Record<string, unknown>>(sql: string, values?: unknown[],
      options?: { deadline: number }) {
      expect(options?.deadline).toBe(deadline);
      if (sql.includes('FROM model_current_effects')) {
        expect(sql).not.toContain('SELECT *');
        expect(values?.at(-1)).toBe(51);
        const plan = await tx.query(`EXPLAIN ${sql}`, values);
        expect(JSON.stringify(plan.rows)).toContain('Index Cond');
        expect(JSON.stringify(plan.rows)).not.toMatch(/Filter:|Sort/);
      }
      return tx.query<Row>(sql, values, options);
    }
    const page = await readCurrentEffects({ query }, 'test', sequence, { limit: 50 }, deadline);
    expect(page.rows).toHaveLength(1);
  }
  await postgres.db.transaction(checkIndex);
  await expect(readCurrentEffects(postgres.db, 'test', sequence + 1)).rejects.toThrow('unavailable');
  for (const limit of [0, 51, 1.5]) {
    await expect(readCurrentEffects(postgres.db, 'test', sequence, { limit })).rejects.toThrow();
  }
  for (const table of ['projection_checkpoints', 'projection_generations', 'projection_versions']) {
    await postgres.db.query(`ALTER TABLE ${table} RENAME TO hidden_metadata`);
    await expect(currentPage()).rejects.toThrow();
    await postgres.db.query(`ALTER TABLE hidden_metadata RENAME TO ${table}`);
  }
  let changed = false;
  async function replacingQuery<Row extends Record<string, unknown>>(sql: string, values?: unknown[],
    options?: { deadline: number }) {
    const result = await postgres.db.query<Row>(sql, values, options);
    if (!changed && sql.includes('FROM model_current_effects')) {
      changed = true;
      await postgres.db.query('UPDATE projection_generations SET generation = generation + 1');
    }
    return result;
  }
  await expect(readCurrentEffects({ query: replacingQuery }, 'test', sequence))
    .rejects.toThrow('unavailable');
}
it('bounds current pages without history and refuses lagging or replaced indexes', boundsCurrentReads);

async function currentReplayRollback() {
  const permitId = await actor.reserve(call(), 120);
  await nats.seed([effectEvent(1, permitId)]);
  await runner.run(budgets);
  const before = await accountingStorage();
  const page = await currentPage();
  const saved = await effectPages();
  await actor.reserve(call(), 70);
  await nats.seed([effectEvent(0, permitId)]);
  const actorBefore = structuredClone(actor.state);
  await postgres.db.query(`ALTER TABLE model_current_effects
    ADD CONSTRAINT refuse_new_hold CHECK ((data->>'heldCents')::integer = 120)`);
  const head = await nats.store.head();
  await expect(rebuildBudgetProjection(postgres.db, nats.reader, logger)).rejects.toThrow();
  expect(await accountingStorage()).toEqual(before);
  expect(await readCurrentEffects(postgres.db, 'test', page.sequence)).toEqual(page);
  expect(await effectPages()).toEqual(saved);
  expect(actor.state).toEqual(actorBefore);
  await postgres.db.query('ALTER TABLE model_current_effects DROP CONSTRAINT refuse_new_hold');
  await rebuildBudgetProjection(postgres.db, nats.reader, logger);
  expect((await currentPage()).rows).toHaveLength(2);
  expect(await nats.store.head()).toBe(head);
}
it('rolls back every accounting table and its receipts if current-effect replacement fails',
  currentReplayRollback);
