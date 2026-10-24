import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { encodeSession } from '@opencrane/auth';
import { createStore, memberAuthorisation } from '@opencrane/authz';
import { event, natsFixture } from '@opencrane/event-store/testing';
import { getEventDefinition, type EventEnvelope } from '@opencrane/events';
import * as models from '@opencrane/models';
import { createLogger } from '@opencrane/observability';
import { ProjectionRunner, rebuildRoutineProjection, routines, type Db, type Query } from '@opencrane/projections';
import { openfga } from '../../../libs/authz/test/services.ts';
import { joinedMember, routine } from '../../../libs/authz/test/routine-fixture.ts';
import { database } from '../../../libs/projections/test/database.ts';
import { buildServer } from '../src/server.ts';
import { conversationListCursor } from '../src/chat/list-cursor.ts';
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
function objectData(value: unknown) {
  if (!value || typeof value !== 'object') throw new Error('Missing fixture data');
  return value;
}
function record(type: string, overrides: Record<string, unknown> = {}): EventEnvelope {
  const example: unknown = getEventDefinition(type)?.example;
  if (!example || typeof example !== 'object') throw new Error('Missing example');
  const data = { ...example, ...overrides };
  const candidate: unknown = Reflect.get(data, 'actorId');
  const actor = typeof candidate === 'string' ? candidate : undefined;
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
  const owner = joinedMember('owner');
  await save({ ...owner, data: { ...objectData(owner.data), role: 'owner' } });
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
  const duePosition = await nats.store.head();
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
  const approval = vi.spyOn(models, 'readApproval');
  const first = await page('limit=50', 'admin');
  expect(first.rows).toHaveLength(50);
  const rest = await page(`continuation=${first.next}`);
  const rows = [...first.rows, ...rest.rows];
  function identity(row: Record<string, unknown>) { return row['occurrenceId']; }
  expect(rows.map(identity)).toEqual(expected);
  expect(rest.next).toBeNull();
  expect(rows[0]).toMatchObject({ eventId: due.id, position: duePosition, recordedAt: due.time,
    activatedAt: activated.time, stopRequestedAt: stopped.time,
    finishedAt: finished.time, outcome: 'cancelled' });
  expect(rows.at(-1)).toMatchObject({ kind: 'missed', count: 100_000 });
  expect((await page()).rows).toHaveLength(20);
  expect((await page('limit=50', 'owner')).rows).toEqual(first.rows);
  await save({ ...finished, id: 'later-result', commandId: 'later-result',
    data: { ...objectData(finished.data), outcome: 'succeeded' } });
  await save({ ...due, id: 'repeat-due', commandId: 'repeat-due' });
  expect((await page('limit=50')).rows).toEqual(first.rows);
  await rebuildRoutineProjection(db, nats.reader, logger, { verify: true });
  expect((await page('limit=50')).rows).toEqual(first.rows);
  expect((await request(`continuation=${first.next}`)).statusCode).toBe(409);
  expect(append).not.toHaveBeenCalled();
  expect(approval).not.toHaveBeenCalled();
  expect(await nats.store.head()).toBe(before + 2);
}
it('pages mixed records, keeps ranges compact and preserves order and first results on replay',
  mixedPages, 30_000);
async function completeRun(occurrenceId: string) {
  const binding = { occurrenceId, rootId: `root-${occurrenceId}`,
    conversationId: `conversation-${occurrenceId}`, messageId: `message-${occurrenceId}`,
    turnId: `turn-${occurrenceId}` };
  const due = record('routine.due', binding);
  const finished = record('routine.run_finished', binding);
  await save(due);
  await save(finished);
  return finished;
}
async function ownRoutineList() {
  const session = { sub: 'alice', orgId: 'org-test', roles: [],
    authTime: 1790856000, exp: 2000000000 };
  const headers = { cookie: `${config.cookieName}=${encodeSession(config, session)}` };
  const response = await app.inject({ method: 'GET', url: '/api/routines?view=mine', headers });
  expect(response.statusCode).toBe(200);
  const result = response.json<Page>();
  expect(result.rows).toHaveLength(1);
  return result.rows;
}
async function lateTerminalRecord() {
  const firstFinished = await completeRun('run-a');
  const secondFinished = await completeRun('run-b');
  const listBefore = await ownRoutineList();
  const before = await page();
  expect(before.rows).toHaveLength(2);
  expect(before.rows[0]).toMatchObject({ occurrenceId: 'run-a', outcome: 'cancelled',
    finishedAt: firstFinished.time });
  expect(before.rows[1]).toMatchObject({ occurrenceId: 'run-b', outcome: 'cancelled',
    finishedAt: secondFinished.time });
  const late = record('routine.run_finished', {
    ...objectData(firstFinished.data), outcome: 'succeeded' });
  await save(late);
  const after = await page();
  expect(after.rows).toEqual(before.rows);
  expect(await ownRoutineList()).toEqual(listBefore);
  expect((await request('', 'bob')).statusCode).toBe(403);
  await rebuildRoutineProjection(db, nats.reader, logger, { verify: true });
  const rebuilt = await page();
  expect(rebuilt.rows).toEqual(before.rows);
  expect(await ownRoutineList()).toEqual(listBefore);
  expect((await request('', 'bob')).statusCode).toBe(403);
}
it('keeps both first outcomes readable after an older run finishes again and after rebuild',
  lateTerminalRecord);

const changedRunBindings = [
  ['rootId', 'other-root'],
  ['conversationId', 'other-conversation'],
  ['messageId', 'other-message'],
  ['turnId', 'other-turn'],
  ['definitionRevision', 2],
  ['scheduleRevision', 2],
  ['controlRevision', 2],
] as const;
async function invalidLateTerminalRecord(field: string, value: string | number) {
  const firstFinished = await completeRun('run-a');
  await completeRun('run-b');
  const before = await page();
  expect(before.rows).toHaveLength(2);
  const late = record('routine.run_finished', {
    ...objectData(firstFinished.data), [field]: value });
  await save(late, false);
  // Check access directly so a lagging projection cannot hide a missing binding check.
  const auth = memberAuthorisation(binding, nats.store);
  const saved = await auth.loadRoutineAccess('alice', 'orders');
  expect(await saved.check('read_metadata')).toEqual({ allowed: false,
    status: 'unavailable', reason: 'history_unavailable' });
  const denied = await auth.loadRoutineAccess('bob', 'orders');
  expect(await denied.check('read_metadata')).toEqual({ allowed: false, status: 'ok' });
}
it.each(changedRunBindings)('refuses a late terminal record with a changed %s',
  invalidLateTerminalRecord);

async function continuations() {
  for (let index = 0; index < 3; index++) {
    await save(record('routine.occurrence_skipped', { occurrenceId: `skip-${index}` }));
  }
  const first = await page('limit=1');
  const foreign = conversationListCursor(config.cookieSecret, ['routine-runs', 'foreign', 'orders']);
  for (const continuation of ['changed', `${first.next}x`, foreign.next([0, 1])]) {
    expect((await request(`continuation=${continuation}`)).statusCode).toBe(409);
  }
  const created = routine('routine.created');
  const other = { ...created, id: 'other', commandId: 'other', subject: 'routine-other',
    data: { ...objectData(created.data), routineId: 'other' } };
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
  if (kind === 'routine') await db.query('DROP TABLE routines');
  if (kind === 'checkpoint') await db.query('DELETE FROM projection_checkpoints');
  const response = await request();
  expect(response.statusCode).toBe(503);
  expect(response.json()).toEqual({ status: 'unavailable' });
}
it.each(['missing', 'lagging', 'generation', 'routine', 'checkpoint'])('never reports an empty %s projection', unavailable);
async function locked(table: string) {
  const acquired = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  async function hold(tx: Query) {
    await tx.query(`LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE`);
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
it.each(['routine_occurrences', 'projection_checkpoints', 'projection_generations'])(
  'bounds blocked %s reads before checking access', locked, 15_000);
async function refusal(kind: string) {
  let actor = 'bob';
  if (kind === 'former') {
    await save(routine('routine.reassigned', 'bob'));
    actor = 'alice';
  }
  if (kind === 'removed') {
    await save(event('removed', 'member-alice', 'member.removed'));
    actor = 'alice';
  }
  if (kind === 'demoted') {
    const demotion = { ...event('demoted', 'member-admin', 'member.role_changed'),
      data: { memberId: 'admin', previousRole: 'admin', newRole: 'member', changedBy: 'owner' } };
    await save(demotion);
    actor = 'admin';
  }
  if (kind === 'outsider') actor = 'outsider';
  const missing = await request('', actor, 'missing');
  expect(missing.statusCode).toBe(403);
  expect((await request('', actor)).body).toBe(missing.body);
  expect((await request('continuation=changed', actor)).body).toBe(missing.body);
  const read = nats.store.readStream.bind(nats.store);
  async function* fail(subject: string, from?: number, deadline?: number) {
    if (subject === 'routine-orders') throw new Error('private-canary');
    yield* read(subject, from, deadline);
  }
  vi.spyOn(nats.store, 'readStream').mockImplementation(fail);
  expect((await request('', 'owner')).statusCode).toBe(503);
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
      if (kind === 'reassign') await nats.seed([routine('routine.reassigned', 'bob')]);
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
    expect(deadline).toBeGreaterThan(clock());
    expect(deadline).toBeLessThanOrEqual(clock() + 10_000);
    yield* read(subject, from, deadline);
    if (subject === 'routine-orders') elapsed += 3000;
  }
  vi.spyOn(nats.store, 'readStream').mockImplementation(slow);
  expect((await page()).rows).toEqual([]);
}
it('allows slow bounded history without a write deadline or unrelated chat reads', slowHistory);

async function finalProjectionCheck() {
  const read = nats.store.readStream.bind(nats.store);
  async function* replace(subject: string, from?: number, deadline?: number) {
    yield* read(subject, from, deadline);
    if (subject === 'routine-orders') await rebuildRoutineProjection(db, nats.reader, logger);
  }
  vi.spyOn(nats.store, 'readStream').mockImplementation(replace);
  expect((await request()).statusCode).toBe(409);
}
it('requires restart when replay replaces the projection during history loading', finalProjectionCheck);

async function latestMembership() {
  const original = db.query.bind(db);
  let progressReads = 0;
  async function query<Row extends Record<string, unknown>>(sql: string, values?: unknown[],
    options?: { deadline: number }) {
    const result = await original<Row>(sql, values, options);
    if (sql.includes('JOIN routines')) {
      progressReads += 1;
      if (progressReads === 2) {
        await nats.seed([event('removed', 'member-alice', 'member.removed')]);
        throw new Error('private-canary');
      }
    }
    return result;
  }
  vi.spyOn(db, 'query').mockImplementation(query);
  const response = await request();
  expect(response.statusCode).toBe(403);
  expect(response.json()).toEqual({ status: 'refused' });
  expect(logs.join('') + response.body).not.toContain('private-canary');
}
it('loads current membership after the final projection check even when it fails', latestMembership);

async function finalReassignment() {
  const original = db.query.bind(db);
  let progressReads = 0;
  async function query<Row extends Record<string, unknown>>(sql: string, values?: unknown[],
    options?: { deadline: number }) {
    const result = await original<Row>(sql, values, options);
    if (sql.includes('JOIN routines') && ++progressReads === 2) {
      await nats.seed([routine('routine.reassigned', 'bob')]);
    }
    return result;
  }
  vi.spyOn(db, 'query').mockImplementation(query);
  const response = await request();
  expect(response.statusCode).toBe(403);
  expect(response.json()).toEqual({ status: 'refused' });
}
it('refuses reassignment during the final page check before IAM catches up', finalReassignment);
