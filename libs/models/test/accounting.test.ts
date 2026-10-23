import { afterEach, beforeEach, expect, it } from 'vitest';
import { natsFixture } from '@opencrane/event-store/testing';
import { createLogger } from '@opencrane/observability';
import { ProjectionRunner, type Query } from '@opencrane/projections';
import { database } from '@opencrane/projections/testing';
import { BudgetActor, envelope } from '../src/actor.ts';
import { budgets, priceTableId, totals } from '../src/state.ts';
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

async function allPages(filters: { payingGroupId?: string; assistantId?: string } = {},
  db: Query = postgres.db) {
  const rows: models.SpendingCall[] = [];
  let after = 0;
  for (let page = 0; page < 30; page += 1) {
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
  for (let index = 0; index < 7; index += 1) {
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
  expect(new Set(ids).size).toBe(21);
  expect(all).toHaveLength(21);
  for (const row of all) expect(row.silo).toBe('test');
  const payerRows = await allPages({ payingGroupId: 'sales' });
  expect(payerRows.map(reservationId)).toEqual(sales);
  const assistantRows = await allPages({ assistantId: 'sales-assistant' });
  expect(assistantRows).toHaveLength(14);
  const combined = await allPages({ payingGroupId: 'support', assistantId: 'sales-assistant' });
  expect(combined.map(reservationId)).toEqual(shared);
  expect(await allPages({ payingGroupId: 'absent' })).toEqual([]);
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
  const saved = { ...original, principal: { kind: 'human' as const, id: 'owner' } };
  await nats.seed([saved]);
  await actor.settleRecorded(id, saved.id);
  return saved.id;
}
async function keepsOriginalMoney() {
  const oldHold = await actor.reserve(call(), 120);
  const late = await actor.reserve(call('support', 'support-assistant'), 100);
  const conflict = await actor.reserve(call(), 120);
  clock = new Date('2026-11-01T00:01:00.000Z');
  await actor.configure({ scope: 'global', ceilingCents: 20_000, setBy: 'owner',
    defaultPayingGroupId: 'support' });
  const receipt = await settle(late, 70);
  await settle(conflict, 80);
  await settle(conflict, 180);
  await runner.run(budgets);
  const before = await allPages();
  const position = await nats.store.head();
  await actor.settleRecorded(late, receipt);
  expect(await nats.store.head()).toBe(position);
  await runner.run(budgets);
  expect(await allPages()).toEqual(before);
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
  const result = await rebuildBudgetProjection(postgres.db, nats.reader, logger, { verify: true });
  expect(result.changed).toBe(false);
  expect(await allPages()).toEqual(before);
  expect(await nats.store.head()).toBe(position);
  expect(actor.state.reservations).toHaveLength(3);
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
