import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { encodeSession } from '@opencrane/auth';
import { createStore, memberAuthorisation } from '@opencrane/authz';
import { databases, openfga } from '@opencrane/authz/testing';
import { event, natsFixture } from '@opencrane/event-store/testing';
import { getEventDefinition } from '@opencrane/events';
import { BudgetActor, budgets, initialiseBudgetProjection, priceTableId,
  rebuildBudgetProjection } from '@opencrane/models';
import { createLogger } from '@opencrane/observability';
import * as protocol from '@opencrane/protocol';
import { pgDb, ProjectionRunner } from '@opencrane/projections';
import { buildServer } from '../src/server.ts';
import type { IntegrationOptions } from '../src/integrations/routes.ts';
import { testAuthConfig } from './support/test-auth-config.ts';

const config = testAuthConfig({ expectedOrgId: 'org-acme' });
const logger = createLogger('spending-effects-test', { level: 'silent' });
let nats: Awaited<ReturnType<typeof natsFixture>>;
let fga: Awaited<ReturnType<typeof openfga>>;
let dbs: Awaited<ReturnType<typeof databases>>;
let options: IntegrationOptions;
let app: ReturnType<typeof buildServer>;
let runner: ProjectionRunner;
let actor: BudgetActor;
let serial = 0;
let outsideCalls = 0;
const permits: string[] = [];
const expected: Record<string, unknown>[] = [];
function memberId(_silo: string, _issuer: string, sub: string) {
  return Promise.resolve(sub);
}
function noCalls(): Promise<never> {
  outsideCalls += 1;
  throw new Error('private-outside-call');
}
async function append(subject: string, type: string, data: unknown, silo = 'acme') {
  const record = { ...event(`spending-effect-${++serial}`, subject, type), silo, data,
    source: 'opencrane-server', commandId: `change-${serial}`,
    principal: { kind: 'human' as const, id: 'owner' }, correlation: {} };
  await nats.seed([record]);
  return record;
}
async function saveEffect(index: number, silo = 'acme') {
  const permitId = permits[index % 2]!;
  const types = ['effect.observed', 'effect.uncertain', 'effect.resolved'];
  const type = types[index % 3]!;
  const payloads = [
    { permitId, computerId: 'private-computer', tool: 'private-tool',
      destination: 'private-destination', costCents: index, outcome: 'success',
      usage: { inputTokens: 100, outputTokens: 10, priceTableId: 'private-tariff' } },
    { permitId, computerId: 'private-computer', reason: 'missing_usage' },
    { permitId, reservationId: permitId, resolvedBy: 'owner', outcome: 'settled',
      settledCents: 0, evidence: [{ kind: 'provider_receipt', reference: 'private-receipt',
        digest: '0'.repeat(64), amountCents: 0 }] },
  ];
  const record = await append(`effect-${permitId}`, type, payloads[index % 3], silo);
  const row = { eventId: record.id, permitId, position: await nats.store.head(),
    time: record.time, type, outcome: null as string | null, costCents: null as number | null,
    settledCents: null as number | null, resolvedBy: null as string | null,
    changeRef: null as string | null };
  if (type === 'effect.observed') {
    row.outcome = 'success';
    row.costCents = index;
  } else if (type === 'effect.resolved') {
    row.outcome = 'settled';
    row.settledCents = 0;
    row.resolvedBy = 'owner';
    row.changeRef = record.commandId;
  }
  return row;
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
  for (const id of ['owner', 'admin', 'removed', 'demoted', 'denied']) {
    const role = id === 'owner' ? 'owner' : 'admin';
    const joined = await append(`member-${id}`, 'member.joined', {
      memberId: id, role, email: `${id}@example.test`, displayName: id,
    });
    if (id !== 'denied') await auth.handler.handle(joined, database);
  }
  await append('member-removed', 'member.removed', { memberId: 'removed', removedBy: 'owner' });
  await append('member-demoted', 'member.role_changed', {
    memberId: 'demoted', previousRole: 'admin', newRole: 'member', changedBy: 'owner',
  });
  actor = new BudgetActor(nats.store, 'acme');
  await actor.start(20_000, 20_000, 'sales');
  const call = { model: 'gpt-6-luna', priceTableId, payingGroupId: 'sales', assistantId: 'assistant',
    computerId: 'private-computer', requesterId: 'owner', conversationId: 'private-chat',
    turnId: 'private-turn', threadId: 'private-thread', contextDigest: '0'.repeat(64) };
  permits.push(await actor.reserve(call, 120), await actor.reserve(call, 120));
  for (let index = 0; index < 63; index++) {
    expected.push(await saveEffect(index));
    await saveEffect(index, 'foreign');
  }
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
function request(query = '', sub = 'owner', orgId = 'org-acme', route = '/effects') {
  const session = { sub, orgId, roles: [], authTime: 1790856000, exp: 2000000000 };
  const headers = { cookie: `${config.cookieName}=${encodeSession(config, session)}` };
  return app.inject({ method: 'GET', url: `/api/org/spending${route}?${query}`, headers });
}
async function page(query = '', sub = 'owner') {
  const response = await request(query, sub);
  expect(response.statusCode).toBe(200);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.body).not.toContain('private-');
  return protocol.spendingEffectsResponseSchema.parse(response.json());
}
beforeAll(initialise, 120_000);
afterAll(close);

async function pagesRecords(sub: string) {
  for (const permitId of [undefined, permits[0], 'absent']) {
    const found = [];
    const filter = permitId === undefined ? '' : `permitId=${permitId}&`;
    let next: string | null = null;
    do {
      let query = filter;
      if (next !== null) query += `continuation=${next}`;
      const result = await page(query, sub);
      expect(result.rows.length).toBeLessThanOrEqual(20);
      found.push(...result.rows);
      next = result.next;
    } while (next);
    function matches(row: Record<string, unknown>) {
      return permitId === undefined || row['permitId'] === permitId;
    }
    expect(found).toEqual(expected.filter(matches));
  }
}
it.each(['owner', 'admin'])('pages separate mixed records without gaps or foreign rows as %s',
  pagesRecords);
async function invalidQuery(query: string) {
  const response = await request(query);
  expect(response.statusCode).toBe(400);
  expect(response.json()).toEqual({ status: 'refused' });
}
it.each(['limit=0', 'limit=51', 'limit=1.5', 'limit=2&limit=3', 'permitId=', 'permitId=*',
  'permitId=a&permitId=b', 'after=1', 'month=2026-10', 'total=true'])(
  'rejects invalid query %s', invalidQuery);
async function continuations() {
  const first = await page(`limit=1&permitId=${permits[0]}`);
  const calls = await request('limit=1', 'owner', 'org-acme', '');
  const callPage = protocol.spendingCallsResponseSchema.parse(calls.json());
  const [encoded, signature] = first.next!.split('.');
  const changed = signature![0] === 'A' ? 'B' : 'A';
  const altered = `${encoded}.${changed}${signature!.slice(1)}`;
  for (const query of [`continuation=${callPage.next}`, `continuation=${first.next}`,
    `permitId=${permits[1]}&continuation=${first.next}`,
    `permitId=${permits[0]}&continuation=${altered}`]) {
    const response = await request(query);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ status: 'restart' });
  }
  expect((await page(`permitId=${permits[0]}&limit=1&continuation=${first.next}`)).rows)
    .toEqual([expected[2]]);
  await options.modelDb!.query('DELETE FROM model_budget_effects WHERE event_id = $1',
    [expected[0]!['eventId']]);
  await rebuildBudgetProjection(pgDb(dbs.queue), nats.reader, logger);
  expect((await request(`permitId=${permits[0]}&continuation=${first.next}`)).statusCode).toBe(409);
}
it('requires restart for call pages, changed permits, signatures and rebuilt generations',
  continuations);
async function finalAccess(kind: string) {
  const database = options.modelDb!;
  const original = database.query.bind(database);
  async function query<Row extends Record<string, unknown>>(sql: string, values?: unknown[],
    readOptions?: { deadline: number }) {
    if (kind === 'failed') throw new Error('private-load-error');
    return original<Row>(sql, values, readOptions);
  }
  database.query = query;
  try {
    const queryString = kind === 'bad' ? 'continuation=bad' : '';
    for (const sub of ['removed', 'demoted', 'denied', 'foreign']) {
      const response = await request(queryString, sub);
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ status: 'refused' });
    }
    expect((await request(queryString, 'owner', 'foreign')).statusCode).toBe(403);
  } finally {
    database.query = original;
  }
}
it.each(['loaded', 'failed', 'bad'])('gives equal refusals after %s loads', finalAccess);
async function duringRead(action: string) {
  await runner.run(budgets);
  const database = options.modelDb!;
  const original = database.query.bind(database);
  async function query<Row extends Record<string, unknown>>(sql: string, values?: unknown[],
    readOptions?: { deadline: number }) {
    const result = await original<Row>(sql, values, readOptions);
    if (sql.includes('FROM model_budget_effects')) {
      if (action === 'slow') {
        await delay(2100);
      } else if (action === 'rebuild') {
        await original('UPDATE projection_generations SET generation = generation + 1');
      } else if (action === 'chat') {
        await append('conversation-private', 'conversation.created',
          getEventDefinition('conversation.created')!.example);
      } else {
        await append('member-admin', 'member.role_changed', {
          memberId: 'admin', previousRole: 'admin', newRole: 'member', changedBy: 'owner',
        });
        if (action === 'demote-failed') throw new Error('private-load-error');
      }
    }
    return result;
  }
  database.query = query;
  try {
    const response = await request('', action.startsWith('demote') ? 'admin' : 'owner');
    const statuses: Record<string, number> = { chat: 200, slow: 503, rebuild: 409,
      demote: 403, 'demote-failed': 403 };
    expect(response.statusCode).toBe(statuses[action]);
  } finally {
    database.query = original;
    await append('member-admin', 'member.role_changed', {
      memberId: 'admin', previousRole: 'member', newRole: 'admin', changedBy: 'owner',
    });
    await runner.run(budgets);
  }
}
it.each(['chat', 'slow', 'rebuild', 'demote', 'demote-failed'])(
  'checks access after loading and ignores unrelated activity: %s', duringRead);
async function unavailable(kind: string) {
  const database = options.modelDb!;
  const original = database.query.bind(database);
  async function query<Row extends Record<string, unknown>>(sql: string, values?: unknown[],
    readOptions?: { deadline: number }) {
    if (kind === 'missing') throw new Error('private-database-error');
    if (sql.includes('SELECT version')) {
      if (kind === 'old') return original<Row>('SELECT 4 AS version, 999 AS sequence, 1 AS generation');
      if (kind === 'absent') return { rows: [] };
    }
    return original<Row>(sql, values, readOptions);
  }
  if (kind === 'lag') await saveEffect(64);
  database.query = query;
  try {
    const response = await request();
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'unavailable' });
  } finally {
    database.query = original;
    await runner.run(budgets);
  }
}
it.each(['missing', 'old', 'absent', 'lag'])('refuses %s projections safely', unavailable);
async function blockedRead() {
  const client = await dbs.queue.connect();
  await client.query('BEGIN');
  await client.query('LOCK TABLE model_budget_effects IN ACCESS EXCLUSIVE MODE');
  const pending = request();
  try {
    const response = await Promise.race([pending, delay(3000)]);
    expect(response?.statusCode).toBe(503);
    expect(response?.json()).toEqual({ status: 'unavailable' });
  } finally {
    await client.query('ROLLBACK');
    client.release();
    await pending;
  }
  await page();
}
it('expires blocked data within the shared deadline without reporting lost access', blockedRead);
async function boundedReadOnly() {
  const database = options.modelDb!;
  const original = database.query.bind(database);
  const readStream = nats.store.readStream.bind(nats.store);
  const head = nats.store.head.bind(nats.store);
  const before = await head();
  const state = structuredClone(actor.state);
  let deadline: number | undefined;
  let captures = 0;
  async function capture(subject?: string, readDeadline?: number) {
    expect(subject).toBeUndefined();
    deadline = readDeadline;
    captures += 1;
    return head(subject, readDeadline);
  }
  async function query<Row extends Record<string, unknown>>(sql: string, values?: unknown[],
    readOptions?: { deadline: number }) {
    expect(sql).not.toContain('FROM model_budgets');
    expect(readOptions?.deadline).toBe(deadline);
    expect(deadline).toBeGreaterThan(performance.now());
    if (sql.includes('FROM model_budget_effects')) expect(values?.at(-1)).toBe(51);
    return original<Row>(sql, values, readOptions);
  }
  function read(...args: Parameters<typeof readStream>) {
    expect(args[0]).toMatch(/^(member-|ownership-)/u);
    return readStream(...args);
  }
  database.query = query;
  nats.store.readStream = read;
  nats.store.head = capture;
  try {
    const result = await page('limit=50');
    expect(result.rows).toHaveLength(50);
    expect(result.sequence).toBe(before);
    expect(captures).toBe(1);
  } finally {
    database.query = original;
    nats.store.readStream = readStream;
    nats.store.head = head;
  }
  const callResponse = await request('', 'owner', 'org-acme', '');
  const calls = protocol.spendingCallsResponseSchema.parse(callResponse.json());
  for (const call of calls.rows) expect(call).toMatchObject({ heldCents: 120, settledCents: null });
  await rebuildBudgetProjection(pgDb(dbs.queue), nats.reader, logger, { verify: true });
  expect((await page('limit=50')).rows).toEqual(expected.slice(0, 50));
  expect(actor.state).toEqual(state);
  expect(await head()).toBe(before);
  expect(outsideCalls).toBe(0);
}
it('uses one bounded position and deadline; GET and replay leave holds and outside work alone',
  boundedReadOnly);

async function strictReply() {
  const result = await page();
  const schema = protocol.spendingEffectsResponseSchema;
  for (const field of ['costCents', 'settledCents']) {
    for (const amount of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      const rows = [{ ...result.rows[0], [field]: amount }];
      expect(schema.safeParse({ ...result, rows }).success).toBe(false);
    }
  }
  const rows = [{ ...result.rows[0], evidence: 'private-evidence' }];
  expect(schema.safeParse({ ...result, rows }).success).toBe(false);
  expect(schema.safeParse({ ...result, totalCents: 0 }).success).toBe(false);
}
it('rejects unsafe cents and private or extra reply fields', strictReply);
