import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { encodeSession } from '@opencrane/auth';
import { createStore, memberAuthorisation } from '@opencrane/authz';
import { databases, openfga } from '@opencrane/authz/testing';
import { event, natsFixture } from '@opencrane/event-store/testing';
import { getEventDefinition } from '@opencrane/events';
import { BudgetActor, budgets, initialiseBudgetProjection, priceTableId,
  rebuildBudgetProjection, type SpendingCall } from '@opencrane/models';
import { createLogger } from '@opencrane/observability';
import * as protocol from '@opencrane/protocol';
import { pgDb, ProjectionRunner } from '@opencrane/projections';
import { buildServer } from '../src/server.ts';
import type { IntegrationOptions } from '../src/integrations/routes.ts';
import { testAuthConfig } from './support/test-auth-config.ts';

const config = testAuthConfig({ expectedOrgId: 'org-acme' });
const logger = createLogger('spending-test', { level: 'silent' });
let nats: Awaited<ReturnType<typeof natsFixture>>;
let fga: Awaited<ReturnType<typeof openfga>>;
let dbs: Awaited<ReturnType<typeof databases>>;
let options: IntegrationOptions;
let app: ReturnType<typeof buildServer>;
let runner: ProjectionRunner;
let actor: BudgetActor;
let clock = new Date('2026-10-31T23:59:00.000Z');
let serial = 0;
const expected: Omit<SpendingCall, 'silo'>[] = [];
type Page = { rows: typeof expected; next: string | null; sequence: number; generation: number };
function now() { return clock; }
function memberId(_silo: string, _issuer: string, sub: string) { return Promise.resolve(sub); }
function noCalls(): Promise<never> { throw new Error('GET must not call tools or models'); }
async function append(subject: string, type: string, data: unknown) {
  const record = { ...event(`spending-${++serial}`, subject, type), silo: 'acme', data,
    principal: { kind: 'human' as const, id: 'owner' }, correlation: {} };
  await nats.seed([record]);
  return record;
}
async function reserve(index: number, writer = actor) {
  const payingGroupId = index % 3 === 0 ? 'sales' : 'support';
  const assistantId = index % 3 === 2 ? 'support-assistant' : 'sales-assistant';
  const call = { model: 'gpt-6-luna', priceTableId, payingGroupId, assistantId,
    computerId: 'private-computer', requesterId: 'owner', conversationId: 'private-chat',
    turnId: 'private-turn', threadId: 'private-thread', contextDigest: '0'.repeat(64) };
  const reservationId = await writer.reserve(call, 120);
  return { reservationId, permitId: reservationId, payingGroupId, assistantId,
    position: await nats.store.head('budget-acme'), reservedAt: clock.toISOString(),
    day: '2026-10-31', month: '2026-10', heldCents: 120, settledCents: null, evidence: 'held' };
}
async function initialise() {
  nats = await natsFixture();
  fga = await openfga();
  dbs = await databases();
  const database = pgDb(dbs.queue);
  const binding = await createStore(fga.apiUrl, 'acme');
  options = { silo: 'acme', binding, store: nats.store, modelDb: database,
    feed: { memberId }, catalogue: { rows: noCalls, tools: noCalls } };
  const auth = memberAuthorisation(binding);
  for (const [id, role] of [['owner', 'owner'], ['admin', 'admin'], ['member', 'member'],
    ['removed', 'admin'], ['denied', 'admin'], ['demote', 'admin'], ['revoke', 'admin']]) {
    const joined = await append(`member-${id}`, 'member.joined', {
      memberId: id, role, email: `${id}@example.test`, displayName: id,
    });
    if (id !== 'denied') await auth.handler.handle(joined, database);
  }
  await append('member-removed', 'member.removed', { memberId: 'removed', removedBy: 'owner' });
  actor = new BudgetActor(nats.store, 'acme', now);
  await actor.start(20_000, 20_000, 'sales');
  for (let index = 0; index < 63; index++) {
    const row = await reserve(index);
    expected.push({ ...row, evidence: 'held' });
  }
  const foreign = new BudgetActor(nats.store, 'other', now);
  await foreign.start(1000, 1000, 'sales');
  await reserve(0, foreign);
  await initialiseBudgetProjection(database, nats.reader, logger);
  runner = new ProjectionRunner(database, nats.reader, logger);
  app = buildServer(config, { integrations: options });
}
async function close() {
  await app?.close();
  await dbs?.close();
  await fga?.close();
  await nats?.close();
}
function request(query = '', sub = 'owner', orgId = 'org-acme', server = app) {
  const session = { sub, orgId, roles: [], authTime: 1790856000, exp: 2000000000 };
  const headers = { cookie: `${config.cookieName}=${encodeSession(config, session)}` };
  return server.inject({ method: 'GET', url: `/api/org/spending?${query}`, headers });
}
async function page(query = '', sub = 'owner') {
  const response = await request(query, sub);
  expect(response.statusCode).toBe(200);
  expect(response.headers['cache-control']).toBe('no-store');
  return protocol.spendingCallsResponseSchema.parse(response.json());
}
beforeAll(initialise, 120_000);
afterAll(close);

async function pagesCalls(sub: string) {
  const before = await nats.store.head();
  const state = structuredClone(actor.state);
  const found: Page['rows'] = [];
  let continuation = '';
  do {
    const result = await page(continuation, sub);
    expect(result.rows.length).toBeLessThanOrEqual(20);
    expect(result.sequence).toBe(before);
    expect(result.generation).toBeGreaterThan(0);
    found.push(...result.rows);
    continuation = result.next ? `continuation=${result.next}` : '';
  } while (continuation);
  expect(found).toEqual(expected);
  expect(await nats.store.head()).toBe(before);
  expect(actor.state).toEqual(state);
}
it.each(['owner', 'admin'])('pages 63 mixed calls with stable positions as %s', pagesCalls);
async function filtersCompose() {
  for (const filters of [{ payingGroupId: 'sales' }, { assistantId: 'sales-assistant' },
    { payingGroupId: 'support', assistantId: 'sales-assistant' }]) {
    function matches(row: Page['rows'][number]) {
      return (!filters.payingGroupId || row.payingGroupId === filters.payingGroupId) &&
        (!filters.assistantId || row.assistantId === filters.assistantId);
    }
    const query = new URLSearchParams({ ...filters, limit: '50' }).toString();
    expect((await page(query)).rows).toEqual(expected.filter(matches));
  }
}
it('composes payer and assistant filters without foreign rows', filtersCompose);
async function rejectsQuery(query: string) {
  const response = await request(query);
  expect(response.statusCode).toBe(400);
  expect(response.json()).toEqual({ status: 'refused' });
}
it.each(['limit=0', 'limit=51', 'limit=1.5', 'limit=9007199254740992', 'limit=2&limit=3',
  'month=2026-10', 'rootId=private', 'after=1', 'payingGroupId=', 'assistantId=*',
  'total=true'])('rejects unsupported or invalid query %s', rejectsQuery);
async function refusesCaller(sub: string) {
  const response = await request('', sub);
  expect(response.statusCode).toBe(403);
  expect(response.json()).toEqual({ status: 'refused' });
}
it.each(['member', 'removed', 'denied'])('hides all money and references from %s', refusesCaller);
async function foreignCaller() {
  expect((await request('', 'owner', 'other')).statusCode).toBe(403);
  const server = buildServer(config, { integrations: { ...options, silo: 'other' } });
  try {
    const response = await request('', 'owner', 'org-acme', server);
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ status: 'refused' });
  } finally { await server.close(); }
}
it('refuses other organisations and mismatched silo bindings', foreignCaller);
async function changesDuringRead(action: string) {
  const database = options.modelDb!;
  const original = database.query.bind(database);
  const loaded = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  async function query<Row extends Record<string, unknown>>(sql: string, values?: unknown[],
    readOptions?: { deadline: number }) {
    if (sql.includes('FROM model_budget_calls')) {
      loaded.resolve();
      await resume.promise;
    }
    return original<Row>(sql, values, readOptions);
  }
  database.query = query;
  const sub = action === 'chat' ? 'owner' : action;
  const pending = request('', sub);
  try {
    await Promise.race([loaded.promise, delay(3000)]);
    if (action === 'demote') {
      await append('member-demote', 'member.role_changed', {
        memberId: sub, previousRole: 'admin', newRole: 'member', changedBy: 'owner',
      });
    } else if (action === 'revoke') {
      await append('member-revoke', 'member.removed', { memberId: sub, removedBy: 'owner' });
    } else {
      await append('conversation-private', 'conversation.created', getEventDefinition('conversation.created')!.example);
    }
    resume.resolve();
    const response = await pending;
    expect(response.statusCode).toBe(action === 'chat' ? 200 : 403);
    if (action !== 'chat') expect(response.json()).toEqual({ status: 'refused' });
  } finally { resume.resolve(); database.query = original; }
}
it.each(['chat', 'demote', 'revoke'])('checks current access after held data read: %s',
  changesDuringRead);
async function refusesUnavailable(kind: string) {
  const database = options.modelDb!;
  const original = database.query.bind(database);
  async function query<Row extends Record<string, unknown>>(sql: string, values?: unknown[],
    readOptions?: { deadline: number }) {
    expect(sql).not.toContain('FROM model_budgets');
    expect(readOptions?.deadline).toBeGreaterThan(performance.now());
    if (sql.includes('FROM model_budget_calls')) {
      expect(values?.at(-1)).toBe(21);
      if (kind === 'missing') throw new Error('Private database canary');
    }
    if (sql.includes('SELECT version')) {
      if (kind === 'old') return { rows: [{ version: 2, sequence: '999', generation: '1' }] as Row[] };
      if (kind === 'absent') return { rows: [] };
      if (kind === 'lag') return { rows: [{ version: 3, sequence: '0', generation: '1' }] as Row[] };
    }
    return original<Row>(sql, values, readOptions);
  }
  database.query = query;
  try {
    const response = await request();
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'unavailable' });
    await refusesCaller('member');
  } finally { database.query = original; }
}
it.each(['missing', 'old', 'absent', 'lag'])('keeps %s index unavailable', refusesUnavailable);
async function lockedRead() {
  const client = await dbs.queue.connect();
  await client.query('BEGIN');
  await client.query('LOCK TABLE model_budget_calls IN ACCESS EXCLUSIVE MODE');
  const pending = request();
  try {
    const response = await Promise.race([pending, delay(3000)]);
    expect(response).toBeDefined();
    expect(response!.statusCode).toBe(503);
    expect(response!.json()).toEqual({ status: 'unavailable' });
  } finally {
    await client.query('ROLLBACK');
    client.release();
    await pending;
  }
  await page();
}
it('expires SQL while the lock remains held and recovers', lockedRead);
async function continuationBinding() {
  const first = await page('limit=1&payingGroupId=support');
  for (const query of [`continuation=${first.next}`, `continuation=${first.next}x`,
    `continuation=${first.next}&payingGroupId=support&assistantId=sales-assistant`]) {
    const response = await request(query);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ status: 'restart' });
  }
  expect((await page(`limit=2&payingGroupId=support&continuation=${first.next}`)).rows)
    .toEqual(expected.slice(2, 3).concat(expected.slice(4, 5)));
  await options.modelDb!.query('DELETE FROM model_budget_calls WHERE reservation_id = $1',
    [expected[0]!.reservationId]);
  await rebuildBudgetProjection(pgDb(dbs.queue), nats.reader, logger);
  const response = await request(`continuation=${first.next}&payingGroupId=support`);
  expect(response.statusCode).toBe(409);
  expect(response.json()).toEqual({ status: 'restart' });
  expect((await page('limit=50')).rows).toEqual(expected.slice(0, 50));
}
it('binds continuation to filters and generation, with explicit restart after rebuild',
  continuationBinding);
async function accountingEvidence() {
  const [zero, released, unknown, late] = expected;
  clock = new Date('2026-11-01T00:01:00.000Z');
  async function settle(id: string, cents: number) {
    const receipt = await append(`effect-${id}`, 'effect.resolved', {
      reservationId: id, permitId: id, settledCents: cents, outcome: 'settled',
      resolvedBy: 'owner', evidence: [{ kind: 'provider_receipt', reference: 'receipt',
        digest: '0'.repeat(64), amountCents: cents }],
    });
    await actor.settleRecorded(id, receipt.id);
  }
  await settle(zero!.reservationId, 0);
  await actor.releaseUndispatched(released!.reservationId);
  await settle(unknown!.reservationId, 80);
  await settle(unknown!.reservationId, 180);
  await settle(late!.reservationId, 70);
  await reserve(0);
  await runner.run(budgets);
  const before = await page('limit=50');
  expect(before.rows.slice(0, 4)).toMatchObject([
    { settledCents: 0, heldCents: 0, evidence: 'settled' },
    { settledCents: 0, heldCents: 0, evidence: 'not_dispatched' },
    { settledCents: 180, heldCents: 120, evidence: 'unknown' },
    { settledCents: 70, day: '2026-10-31', month: '2026-10' },
  ]);
  expect(before.rows[4]).toMatchObject({ settledCents: null, heldCents: 120 });
  const next = await page(`limit=50&continuation=${before.next}`);
  expect(next.rows.at(-1)).toMatchObject({ month: '2026-11', day: '2026-11-01' });
  const position = await nats.store.head();
  await rebuildBudgetProjection(pgDb(dbs.queue), nats.reader, logger, { verify: true });
  expect((await page('limit=50')).rows).toEqual(before.rows);
  expect(await nats.store.head()).toBe(position);
}
it('preserves zero, null, release, unknown holds and late original-period charges through replay',
  accountingEvidence);
