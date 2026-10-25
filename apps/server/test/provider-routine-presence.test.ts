import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { encodeSession } from '@opencrane/auth';
import { createStore, memberAuthorisation } from '@opencrane/authz';
import { event, natsFixture } from '@opencrane/event-store/testing';
import { getEventDefinition,
  type EventEnvelope } from '@opencrane/events';
import { createLogger } from '@opencrane/observability';
import { ProjectionRunner, rebuildRoutineProjection, routines,
  type Db } from '@opencrane/projections';
import { openfga } from '../../../libs/authz/test/services.ts';
import { joinedMember, routine } from '../../../libs/authz/test/routine-fixture.ts';
import { database } from '../../../libs/projections/test/database.ts';
import { buildServer } from '../src/server.ts';
import { testAuthConfig } from './support/test-auth-config.ts';

const config = testAuthConfig({ expectedOrgId: 'org-test' });
const logger = createLogger('provider-presence-test', { level: 'silent' });
let nats: Awaited<ReturnType<typeof natsFixture>>;
let fga: Awaited<ReturnType<typeof openfga>>;
let storage: Awaited<ReturnType<typeof database>>;
let db: Db;
let runner: ProjectionRunner;
let app: ReturnType<typeof buildServer>;
let logs: string[];
function write(line: string) { logs.push(line); }
function memberId(_silo: string, _issuer: string, sub: string) { return Promise.resolve(sub); }
async function setup() {
  logs = [];
  storage = await database('pg');
  db = storage.db;
  nats = await natsFixture();
  fga = await openfga();
  const binding = await createStore(fga.apiUrl, 'test');
  const auth = memberAuthorisation(binding, nats.store);
  const provider = { ...event('provider-created', 'provider-primary', 'provider.created'),
    data: { providerId: 'primary', provider: 'openai', name: 'Primary',
      revision: 1, changedBy: 'admin' } };
  for (const saved of [joinedMember('admin'), joinedMember('alice'), provider]) {
    await nats.seed([saved]);
    await auth.handler.handle(saved, db);
  }
  runner = new ProjectionRunner(db, nats.reader, logger);
  await runner.initialise(routines);
  await runner.run(routines);
  const providers = { silo: 'test', store: nats.store, binding, db, feed: { memberId } };
  app = buildServer(config, { providers, logDestination: { write } });
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
function request(actor = 'admin', providerId = 'primary') {
  const session = { sub: actor, orgId: 'org-test', roles: [], authTime: 1, exp: 2000000000 };
  const headers = { cookie: `${config.cookieName}=${encodeSession(config, session)}` };
  return app.inject({ method: 'GET', url: `/api/org/providers/${providerId}/bindings`, headers });
}
async function result(status: 'absent' | 'unsupported', position: number) {
  const response = await request();
  expect(response.statusCode).toBe(200);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.json()).toMatchObject({ ordinaryCallsAvailable: false,
    routines: { status, position } });
  expect(response.body + logs.join('')).not.toMatch(/orders|ciphertext|private-canary/u);
  return response.json<unknown>();
}
function legacy(index = 0): EventEnvelope {
  const routineId = `legacy-${index}`;
  return { ...event(`paused-${index}`, `routine-${routineId}`, 'routine.paused'),
    data: { routineId, pausedBy: 'admin' } };
}
async function empty() {
  await result('absent', 0);
  await rebuildRoutineProjection(db, nats.reader, logger, { verify: true });
  await result('absent', 0);
}
it('reports absence only from an empty caught-up projection, including after replay', empty);
async function recorded(kind: string) {
  let saved = routine('routine.created');
  if (kind === 'legacy') saved = legacy();
  if (kind === 'active') {
    const data = saved.data;
    if (!data || typeof data !== 'object') throw new Error('Missing routine fixture');
    saved = { ...saved, data: { ...data, status: 'active' } };
  }
  await nats.seed([saved]);
  if (kind === 'retired') await nats.seed([routine('routine.retired')]);
  await runner.run(routines);
  const position = await nats.store.head('routine-*');
  const before = await nats.store.head();
  const append = vi.spyOn(nats.store, 'append');
  const initial = await result('unsupported', position);
  await rebuildRoutineProjection(db, nats.reader, logger, { verify: true });
  expect(await result('unsupported', position)).toEqual(initial);
  expect(append).not.toHaveBeenCalled();
  expect(await nats.store.head()).toBe(before);
}
it.each(['modern', 'legacy', 'active', 'retired'])(
  'keeps %s records unsupported before and after effect-free replay', recorded);
function catalogueRoutine(type: string, id: string): EventEnvelope {
  const data: unknown = getEventDefinition(type)?.example;
  if (!data || typeof data !== 'object') throw new Error('Missing routine example');
  const actor: unknown = Reflect.get(data, 'actorId');
  const principal = { kind: 'system' as 'system' | 'human', id: 'opencrane-server' };
  if (typeof actor === 'string') {
    principal.kind = 'human';
    principal.id = actor;
  }
  return { ...event(id, 'routine-orders', type), source: 'opencrane-server', data, principal };
}
async function duplicatePosition() {
  const records = [catalogueRoutine('routine.created', 'created'),
    catalogueRoutine('routine.resumed', 'resumed'), catalogueRoutine('routine.due', 'due'),
    catalogueRoutine('routine.due', 'duplicate-due')];
  await nats.seed(records);
  await runner.run(routines);
  const position = await nats.store.head('routine-*');
  const projected = await db.query('SELECT position FROM routines WHERE silo = $1', ['test']);
  expect(Number(projected.rows[0]?.['position'])).toBeLessThan(position);
  await result('unsupported', position);
}
it('returns the category position when a repeated outcome does not move the routine row',
  duplicatePosition);
async function volume() {
  const events: EventEnvelope[] = [];
  for (let index = 0; index < 2001; index++) events.push(legacy(index));
  await nats.seed(events);
  await runner.run(routines);
  const originalRead = nats.store.readStream.bind(nats.store);
  async function* boundedRead(subject: string, from?: number, deadline?: number) {
    expect(subject).not.toBe('routine-*');
    yield* originalRead(subject, from, deadline);
  }
  vi.spyOn(nats.store, 'readStream').mockImplementation(boundedRead);
  const originalQuery = db.query.bind(db);
  let lookups = 0;
  async function boundedQuery<Row extends Record<string, unknown>>(sql: string, values?: unknown[],
    options?: { deadline: number }) {
    const read = await originalQuery<Row>(sql, values, options);
    if (/FROM routines\b/u.test(sql)) {
      lookups++;
      expect(sql).toMatch(/SELECT position\s+FROM routines/iu);
      expect(sql).toMatch(/WHERE silo = \$1\s+ORDER BY position DESC LIMIT 1/iu);
      expect(values).toEqual(['test']);
      expect(read.rows).toHaveLength(1);
      expect(Object.keys(read.rows[0]!)).toEqual(['position']);
      expect(options?.deadline).toBeGreaterThan(performance.now());
    }
    return read;
  }
  vi.spyOn(db, 'query').mockImplementation(boundedQuery);
  await result('unsupported', await nats.store.head('routine-*'));
  expect(lookups).toBeGreaterThan(0);
}
it('uses a bounded position lookup for thousands of events without reading routine history',
  volume, 120_000);
async function lag() {
  await nats.seed([legacy()]);
  expect((await request()).statusCode).toBe(503);
  await runner.run(routines);
  await result('unsupported', await nats.store.head('routine-*'));
}
it('does not report absence while projection work is behind', lag);
function failLookup(expire = false) {
  const originalQuery = db.query.bind(db);
  async function unavailableQuery<Row extends Record<string, unknown>>(sql: string,
    values?: unknown[], options?: { deadline: number }) {
    if (/FROM routines\b/u.test(sql)) {
      if (expire) {
        vi.spyOn(performance, 'now').mockReturnValue(options!.deadline + 1);
      }
      throw new Error('private-canary orders ciphertext');
    }
    return originalQuery<Row>(sql, values, options);
  }
  vi.spyOn(db, 'query').mockImplementation(unavailableQuery);
}
async function unavailable(kind: string) {
  if (kind === 'missing') {
    await db.query("DELETE FROM projection_checkpoints WHERE name = 'routines'");
  } else {
    failLookup();
  }
  const response = await request();
  expect(response.statusCode).toBe(503);
  expect(response.json()).toEqual({ status: 'unavailable' });
  expect(response.body + logs.join('')).not.toMatch(/orders|ciphertext|private-canary/u);
}
it.each(['missing', 'failed'])('refuses %s projection knowledge without private details', unavailable);
async function refusal(actor: string, fail: boolean) {
  if (actor === 'admin') {
    const removed = { ...event('removed', 'member-admin', 'member.removed'),
      data: { memberId: 'admin', removedBy: 'admin' } };
    await nats.seed([removed]);
  }
  if (fail) failLookup();
  const response = await request(actor);
  expect(response.statusCode).toBe(403);
  expect(response.json()).toEqual({ status: 'refused' });
  expect(response.body + logs.join('')).not.toMatch(/orders|ciphertext|private-canary/u);
}
it.each([['admin', false], ['admin', true], ['alice', false], ['alice', true]] as const)(
  'returns the same refusal to %s when lookup fails: %s', refusal);
async function expiredPreparation(actor: string) {
  failLookup(true);
  await refusal(actor, false);
}
it.each(['admin', 'alice'])('still checks %s after routine preparation expires', expiredPreparation);
async function providerRefusal() {
  failLookup();
  const response = await request('admin', 'missing');
  expect(response.statusCode).toBe(403);
  expect(response.json()).toEqual({ status: 'refused' });
}
it('checks provider permission before disclosing a failed lookup', providerRefusal);
async function changed(kind: string) {
  const originalQuery = db.query.bind(db);
  let changed = false;
  async function race<Row extends Record<string, unknown>>(sql: string, values?: unknown[],
    options?: { deadline: number }) {
    const read = await originalQuery<Row>(sql, values, options);
    if (!changed && /FROM routines\b/u.test(sql)) {
      changed = true;
      if (kind === 'rebuild') {
        await rebuildRoutineProjection(db, nats.reader, logger, { verify: true });
      } else if (kind === 'removal') {
        const removed = { ...event('removed', 'member-admin', 'member.removed'),
          data: { memberId: 'admin', removedBy: 'admin' } };
        await nats.seed([removed]);
      } else if (kind === 'chat') {
        const message = { ...event('chat', 'conversation-unrelated', 'message.posted'),
          data: getEventDefinition('message.posted')?.example };
        await nats.seed([message]);
        await runner.run(routines);
      } else {
        await nats.seed([legacy()]);
        if (kind === 'projected insertion') await runner.run(routines);
      }
    }
    return read;
  }
  vi.spyOn(db, 'query').mockImplementation(race);
  const response = await request();
  expect(changed).toBe(true);
  if (kind === 'chat') {
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ routines: { status: 'absent', position: 0 } });
  } else if (kind === 'removal') {
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ status: 'refused' });
  } else {
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'unavailable' });
  }
}
it.each(['rebuild', 'insertion', 'projected insertion', 'chat', 'removal'])(
  'checks routine movement while preserving unrelated reads: %s', changed);
