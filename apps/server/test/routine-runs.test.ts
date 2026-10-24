import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { encodeSession } from '@opencrane/auth';
import { createStore, memberAuthorisation } from '@opencrane/authz';
import { event, natsFixture } from '@opencrane/event-store/testing';
import { getEventDefinition, type EventEnvelope } from '@opencrane/events';
import { createLogger } from '@opencrane/observability';
import { ProjectionRunner, rebuildRoutineProjection, routines, type Db, type Query } from '@opencrane/projections';
import { openfga } from '../../../libs/authz/test/services.ts';
import { joinedMember, routine } from '../../../libs/authz/test/routine-fixture.ts';
import { database } from '../../../libs/projections/test/database.ts';
import { buildServer } from '../src/server.ts';
import { testAuthConfig } from './support/test-auth-config.ts';

const config = testAuthConfig({ expectedOrgId: 'org-test' });
const logger = createLogger('routine-runs-test', { level: 'silent' });
let nats: Awaited<ReturnType<typeof natsFixture>>;
let fga: Awaited<ReturnType<typeof openfga>>;
let storage: Awaited<ReturnType<typeof database>>;
let binding: Awaited<ReturnType<typeof createStore>>;
let runner: ProjectionRunner;
let app: ReturnType<typeof buildServer>;
let db: Db;
let serial: number;
let logs: string[];
function write(line: string) { logs.push(line); }
function memberId(_silo: string, _issuer: string, sub: string) { return Promise.resolve(sub); }
function record(type: string, overrides: Record<string, unknown> = {}): EventEnvelope {
  const example: unknown = getEventDefinition(type)?.example;
  if (!example || typeof example !== 'object') throw new Error('Missing example');
  const data = { ...example, ...overrides };
  const actor = Reflect.get(data, 'actorId') as string | undefined;
  const principal = { kind: actor ? 'human' as const : 'system' as const,
    id: actor ?? 'opencrane-server' };
  return { ...event(`record-${++serial}`, 'routine-orders', type), data, principal,
    source: 'opencrane-server', commandId: `change-${serial}`,
    time: new Date(Date.UTC(2026, 9, 11, 7, 0, serial)).toISOString() };
}
async function save(saved: EventEnvelope, project = true) {
  await nats.seed([saved]);
  const auth = memberAuthorisation(binding, nats.store);
  if (auth.handler.eventTypes.includes(saved.type)) await auth.handler.handle(saved, db);
  if (project) await runner.run(routines);
}
async function setup() {
  serial = 0;
  logs = [];
  storage = await database('pg');
  db = storage.db;
  nats = await natsFixture();
  fga = await openfga();
  binding = await createStore(fga.apiUrl, 'test');
  runner = new ProjectionRunner(db, nats.reader, logger);
  await runner.initialise(routines);
  for (const actor of ['alice', 'admin', 'bob']) await save(joinedMember(actor));
  await save(record('routine.created', { status: 'active' }));
  const memberReads = { silo: 'test', store: nats.store, binding, db, feed: { memberId } };
  app = buildServer(config, { memberReads, logDestination: { write } });
  app.log.level = 'info';
}
async function cleanup() {
  vi.restoreAllMocks();
  await app?.close();
  await fga?.close();
  await nats?.close();
  await storage?.close();
}
beforeEach(setup, 30_000);
afterEach(cleanup);
function request(query = '', actor = 'alice', routineId = 'orders') {
  const session = { sub: actor, orgId: 'org-test', roles: [], authTime: 1790856000, exp: 2000000000 };
  const headers = { cookie: `${config.cookieName}=${encodeSession(config, session)}` };
  return app.inject({ method: 'GET', url: `/api/routines/${routineId}/runs?${query}`, headers });
}
type Page = { rows: Record<string, unknown>[]; next: string | null; executionAvailable: false };
async function page(query = '', actor = 'alice') {
  const response = await request(query, actor);
  expect(response.statusCode).toBe(200);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.body + logs.join('')).not.toMatch(
    /private-canary|ciphertext|key:1|orders-bot|conversationId|resultReference|Cents/u);
  const result = response.json<Page>();
  expect(result.executionAvailable).toBe(false);
  return result;
}
async function mixedPages() {
  const expected: string[] = [];
  const due = record('routine.due');
  await save(due);
  expected.push('occurrence');
  const activated = record('routine.run_activation_admitted');
  await save(activated);
  const stopped = record('routine.run_stop_requested');
  await save(stopped);
  for (let index = 0; index < 60; index++) {
    const occurrenceId = `skip-${index}`;
    await save(record('routine.occurrence_skipped', { occurrenceId }));
    expected.push(occurrenceId);
  }
  await save(record('routine.occurrences_missed', { count: 100_000 }));
  expected.push('missed:1:2026-10-09:2026-10-10');
  const finished = record('routine.run_finished', {
    resultReference: { eventId: 'private-canary', position: 1 } });
  await save(finished);
  const before = await nats.store.head();
  const append = vi.spyOn(nats.store, 'append');
  const first = await page('limit=50', 'admin');
  expect(first.rows).toHaveLength(50);
  const rest = await page(`continuation=${first.next}`);
  const rows = [...first.rows, ...rest.rows];
  function identity(row: Record<string, unknown>) { return row['occurrenceId']; }
  expect(rows.map(identity)).toEqual(expected);
  expect(rest.next).toBeNull();
  expect(rows[0]).toMatchObject({ eventId: due.id, recordedAt: due.time,
    activatedAt: activated.time, stopRequestedAt: stopped.time,
    finishedAt: finished.time, outcome: 'cancelled' });
  expect(rows.at(-1)).toMatchObject({ kind: 'missed', count: 100_000 });
  expect((await page()).rows).toHaveLength(20);
  await save({ ...finished, id: 'later-result', commandId: 'later-result',
    data: { ...finished.data as object, outcome: 'succeeded' } });
  await save({ ...due, id: 'repeat-due', commandId: 'repeat-due' });
  expect((await page('limit=50')).rows).toEqual(first.rows);
  await rebuildRoutineProjection(db, nats.reader, logger, { verify: true });
  expect((await page('limit=50')).rows).toEqual(first.rows);
  expect((await request(`continuation=${first.next}`)).statusCode).toBe(409);
  expect(append).not.toHaveBeenCalled();
  expect(await nats.store.head()).toBe(before + 2);
}
it('pages mixed records, keeps ranges compact and preserves order and first results on replay',
  mixedPages, 30_000);
async function continuations() {
  for (let index = 0; index < 3; index++) {
    await save(record('routine.occurrence_skipped', { occurrenceId: `skip-${index}` }));
  }
  const first = await page('limit=1');
  for (const continuation of ['changed', `${first.next}x`]) {
    expect((await request(`continuation=${continuation}`)).statusCode).toBe(409);
  }
  const created = routine('routine.created');
  const other = { ...created, id: 'other', commandId: 'other', subject: 'routine-other',
    data: { ...created.data as object, routineId: 'other' } };
  await save(other);
  expect((await request(`continuation=${first.next}`, 'alice', 'other')).statusCode).toBe(409);
  for (const query of ['limit=51', 'limit=0', 'limit=1.5', 'limit=2&limit=3', 'extra=1']) {
    expect((await request(query)).statusCode).toBe(400);
  }
}
it('requires restart for altered and foreign continuations and rejects invalid bounds', continuations);
async function unavailable(kind: string) {
  if (kind === 'missing') await db.query('DROP TABLE routine_occurrences');
  if (kind === 'lagging') await save(record('routine.occurrence_skipped'), false);
  if (kind === 'generation') await db.query('DELETE FROM projection_generations');
  const response = await request();
  expect(response.statusCode).toBe(503);
  expect(response.json()).toEqual({ status: 'unavailable' });
}
it.each(['missing', 'lagging', 'generation'])('never reports an empty %s projection', unavailable);
async function locked() {
  const acquired = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  async function hold(tx: Query) {
    await tx.query('LOCK TABLE routine_occurrences IN ACCESS EXCLUSIVE MODE');
    acquired.resolve();
    await release.promise;
  }
  const pending = db.transaction(hold);
  await acquired.promise;
  try {
    const response = await request();
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'unavailable' });
  } finally {
    release.resolve();
    await pending;
  }
  expect((await page()).rows).toEqual([]);
}
it('bounds blocked page reads before checking access', locked, 15_000);
async function refusal(kind: string) {
  let actor = 'bob';
  if (kind === 'former') { await save(routine('routine.reassigned', 'bob')); actor = 'alice'; }
  if (kind === 'removed') {
    await save(event('removed', 'member-alice', 'member.removed')); actor = 'alice';
  }
  if (kind === 'demoted') {
    const demotion = { ...event('demoted', 'member-admin', 'member.role_changed'),
      data: { memberId: 'admin', previousRole: 'admin', newRole: 'member', changedBy: 'owner' } };
    await save(demotion); actor = 'admin';
  }
  if (kind === 'outsider') actor = 'outsider';
  const missing = await request('', actor, 'missing');
  expect(missing.statusCode).toBe(403);
  expect((await request('', actor)).body).toBe(missing.body);
  const read = nats.store.readStream.bind(nats.store);
  async function* fail(subject: string, from?: number, deadline?: number) {
    if (subject === 'routine-orders') throw new Error('private-canary');
    yield* read(subject, from, deadline);
  }
  vi.spyOn(nats.store, 'readStream').mockImplementation(fail);
  expect((await request('', actor)).body).toBe(missing.body);
  await db.query('DROP TABLE routine_occurrences');
  expect((await request('', actor)).body).toBe(missing.body);
  expect(logs.join('')).not.toContain('private-canary');
}
it.each(['ordinary', 'former', 'removed', 'demoted', 'outsider'])(
  'gives equal refusals to %s readers after successful and failed loading', refusal);
async function duringPage(kind: string) {
  const original = db.query.bind(db);
  async function query<Row extends Record<string, unknown>>(sql: string, values?: unknown[],
    options?: { deadline: number }) {
    if (options) expect(options.deadline).toBeLessThanOrEqual(performance.now() + 10_000);
    const result = await original<Row>(sql, values, options);
    if (sql.includes('FROM routine_occurrences')) {
      expect(values?.at(-1)).toBe(21);
      if (kind === 'reassign') await save(routine('routine.reassigned', 'bob'));
      if (kind === 'rebuild') await rebuildRoutineProjection(db, nats.reader, logger);
      if (kind === 'chat') await nats.seed([event('chat', 'conversation-unrelated')]);
    }
    return result;
  }
  vi.spyOn(db, 'query').mockImplementation(query);
  const response = await request();
  const expected: Record<string, number> = { reassign: 403, rebuild: 409, chat: 200 };
  expect(response.statusCode).toBe(expected[kind]);
}
it.each(['reassign', 'rebuild', 'chat'])('checks access and generation after %s during loading', duringPage);

async function slowHistory() {
  const read = nats.store.readStream.bind(nats.store);
  const now = performance.now.bind(performance);
  let elapsed = 0;
  function clock() { return now() + elapsed; }
  vi.spyOn(performance, 'now').mockImplementation(clock);
  async function* slow(subject: string, from?: number, deadline?: number) {
    expect(subject).toMatch(/^(routine-orders|member-alice|ownership-test)$/u);
    expect(deadline).toBeGreaterThan(clock() + 9000);
    yield* read(subject, from, deadline);
    if (subject === 'routine-orders') elapsed += 3000;
  }
  vi.spyOn(nats.store, 'readStream').mockImplementation(slow);
  expect((await page()).rows).toEqual([]);
}
it('allows slow bounded history without a write deadline or unrelated chat reads', slowHistory);
