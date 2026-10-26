import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { encodeSession } from '@opencrane/auth';
import { createStore, memberAuthorisation } from '@opencrane/authz';
import { event, natsFixture } from '@opencrane/event-store/testing';
import { type EventEnvelope } from '@opencrane/events';
import { createLogger } from '@opencrane/observability';
import { ProjectionRunner, rebuildRoutineProjection, readInventoryReferences, routines, members, conversations, computers,
  type Db, type Query } from '@opencrane/projections';
import { openfga } from '../../../libs/authz/test/services.ts';
import { joinedMember, routine } from '../../../libs/authz/test/routine-fixture.ts';
import { database } from '../../../libs/projections/test/database.ts';
import { memberInventory } from '../src/members/inventory.ts';
import { removalCommand } from '../src/members/removal.ts';
import { memberDepartureSchema } from '@opencrane/protocol';
import type { GroupOptions } from '../src/members/group-routes.ts';
import { buildServer } from '../src/server.ts';
import { testAuthConfig } from './support/test-auth-config.ts';

const config = testAuthConfig({ expectedOrgId: 'org-test' });
const logger = createLogger('member-routine-presence-test', { level: 'silent' });
let nats: Awaited<ReturnType<typeof natsFixture>>;
let fga: Awaited<ReturnType<typeof openfga>>;
let storage: Awaited<ReturnType<typeof database>>;
let db: Db;
let runner: ProjectionRunner;
let app: ReturnType<typeof buildServer>;
let logs: string[];
let memberReads: GroupOptions;
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
  for (const saved of [joinedMember('admin'), joinedMember('alice')]) {
    await nats.seed([saved]);
    await auth.handler.handle(saved, db);
  }
  runner = new ProjectionRunner(db, nats.reader, logger);
  for (const projection of [members, conversations, computers, routines]) {
    await runner.initialise(projection);
  }
  await project();
  memberReads = { silo: 'test', store: nats.store, binding, db, feed: { memberId } };
  app = buildServer(config, { memberReads, logDestination: { write } });
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
async function project() {
  for (const projection of [members, conversations, computers, routines]) {
    await runner.run(projection);
  }
}
function request(actor = 'admin') {
  const session = { sub: actor, orgId: 'org-test', roles: [], authTime: 1, exp: 2000000000 };
  const headers = { cookie: `${config.cookieName}=${encodeSession(config, session)}` };
  return app.inject({ method: 'GET', url: '/api/members/alice/departure', headers });
}
async function result(status: 'absent_on_version' | 'unsupported_history' | 'unavailable') {
  const response = await request();
  expect(response.statusCode).toBe(200);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.json()).toMatchObject({ routines: { status },
    permissions: { remove: status === 'absent_on_version' } });
  expect(response.body + logs.join('')).not.toMatch(/orders|ciphertext|private-canary/u);
  return response;
}
function legacy(index = 0): EventEnvelope {
  const routineId = `legacy-${index}`;
  return { ...event(`paused-${index}`, `routine-${routineId}`, 'routine.paused'),
    data: { routineId, pausedBy: 'admin' } };
}
async function projectVolume() {
  async function applyBatch(transaction: Query) {
    async function inBatch<Result>(work: (db: Query) => Promise<Result>) {
      return work(transaction);
    }
    // Commit this fixture together instead of committing every unrelated receipt separately.
    const batchDb = { query: transaction.query.bind(transaction), transaction: inBatch };
    const batchRunner = new ProjectionRunner(batchDb, nats.reader, logger);
    for (const projection of [members, conversations, computers, routines]) {
      await batchRunner.run(projection);
    }
  }
  await db.transaction(applyBatch);
}

async function volume(count: number) {
  const records: EventEnvelope[] = [];
  for (let index = 0; index < count; index++) records.push(legacy(index));
  await nats.seed(records);
  await projectVolume();
  const originalRead = nats.store.readStream.bind(nats.store);
  async function* boundedRead(subject: string, from?: number, deadline?: number) {
    expect(subject.startsWith('routine-')).toBe(false);
    yield* originalRead(subject, from, deadline);
  }
  const reads = vi.spyOn(nats.store, 'readStream').mockImplementation(boundedRead);
  const originalQuery = db.query.bind(db);
  let lookups = 0;
  async function boundedQuery<Row extends Record<string, unknown>>(sql: string, values?: unknown[],
    options?: { deadline: number }) {
    const read = await originalQuery<Row>(sql, values, options);
    if (/FROM routines\b/u.test(sql)) {
      lookups++;
      expect(sql).toMatch(/SELECT position\s+FROM routines/iu);
      expect(sql).toMatch(/WHERE silo = \$1\s+ORDER BY position DESC LIMIT 1/iu);
      expect(read.rows).toHaveLength(1);
      expect(Object.keys(read.rows[0]!)).toEqual(['position']);
    }
    return read;
  }
  vi.spyOn(db, 'query').mockImplementation(boundedQuery);
  const response = await result('unsupported_history');
  expect(response.json()).toMatchObject({ unavailableSections: ['routine'] });
  expect(lookups).toBe(1);
  const cleanup = await readInventoryReferences(db, 'test', 'alice');
  expect(cleanup.complete).toBe(false);
  expect(cleanup.references[0]?.subject).toMatch(/^routine-/u);
  for (const [subject] of reads.mock.calls) expect(subject.startsWith('routine-')).toBe(false);
}
it.each([101, 2001])('prepares a bounded departure review for %i routine streams', volume, 120_000);

async function emptyAndReplay() {
  const before = await nats.store.head();
  const append = vi.spyOn(nats.store, 'append');
  await result('absent_on_version');
  await rebuildRoutineProjection(db, nats.reader, logger, { verify: true });
  await result('absent_on_version');
  expect(append).not.toHaveBeenCalled();
  expect(await nats.store.head()).toBe(before);
}
it('proves empty history before and after replay without effects', emptyAndReplay);

async function recorded(kind: string) {
  let saved = routine('routine.created');
  if (kind === 'legacy') saved = legacy();
  await nats.seed([saved]);
  if (kind === 'retired') await nats.seed([routine('routine.retired')]);
  await project();
  const before = await nats.store.head();
  const append = vi.spyOn(nats.store, 'append');
  await result('unsupported_history');
  const cleanup = await readInventoryReferences(db, 'test', 'alice');
  expect(cleanup.references).toContainEqual({ subject: saved.subject, position: String(before) });
  await rebuildRoutineProjection(db, nats.reader, logger, { verify: true });
  await result('unsupported_history');
  expect(append).not.toHaveBeenCalled();
  expect(await nats.store.head()).toBe(before);
}
it.each(['modern', 'legacy', 'retired'])(
  'keeps %s history as a blocker for reads and cleanup after replay', recorded);

async function uncertainty(kind: string) {
  await result('absent_on_version');
  if (kind === 'lag') {
    await nats.seed([legacy()]);
    await runner.run(members);
  } else if (kind === 'checkpoint') {
    await db.query("DELETE FROM projection_checkpoints WHERE name = 'routines'");
  } else {
    const query = db.query.bind(db);
    async function failed<Row extends Record<string, unknown>>(sql: string, values?: unknown[],
      options?: { deadline: number }) {
      if (/FROM routines\b/u.test(sql)) throw new Error('private-canary ciphertext orders');
      return query<Row>(sql, values, options);
    }
    vi.spyOn(db, 'query').mockImplementation(failed);
  }
  await result('unavailable');
}
it.each(['lag', 'checkpoint', 'lookup'])('never proves absence with %s uncertainty', uncertainty);

async function racing(kind: string, failure = '') {
  if (kind === 'chat') {
    const data = { conversationId: 'unrelated', assistantId: 'helper', createdBy: 'someone-else' };
    const created = { ...event('created-chat', 'conversation-unrelated', 'conversation.created'),
      data };
    await nats.seed([created]);
    await project();
  }
  await result('absent_on_version');
  const query = db.query.bind(db);
  let changed = false;
  async function race<Row extends Record<string, unknown>>(sql: string, values?: unknown[],
    options?: { deadline: number }) {
    const read = await query<Row>(sql, values, options);
    let preparationQuery = /FROM routines\b/u.test(sql);
    if (failure === 'inventory') preparationQuery = /FROM inventory_inputs\b/u.test(sql);
    if (!changed && preparationQuery) {
      changed = true;
      if (kind === 'rebuild') {
        await rebuildRoutineProjection(db, nats.reader, logger, { verify: true });
      } else if (kind === 'removed' || kind === 'demoted') {
        let type = 'member.removed';
        let data: unknown = { memberId: 'admin', removedBy: 'admin' };
        if (kind === 'demoted') {
          type = 'member.role_changed';
          data = { memberId: 'admin', previousRole: 'admin', newRole: 'member', changedBy: 'admin' };
        }
        const changedAccess = { ...event('access-changed', 'member-admin', type), data };
        await nats.seed([changedAccess]);
      } else if (kind === 'chat') {
        const message = { ...event('chat', 'conversation-unrelated', 'message.posted'),
          data: { conversationId: 'unrelated', authorId: 'someone-else', authorKind: 'human',
            ciphertext: Buffer.from('Unrelated test message').toString('base64'),
            keyId: 'key:unrelated', contentType: 'text' } };
        await nats.seed([message]);
        await project();
      } else {
        await nats.seed([legacy()]);
        if (kind === 'projected insertion') await project();
      }
      if (failure === 'expired') {
        vi.spyOn(performance, 'now').mockReturnValue(options!.deadline + 1);
      }
      if (failure) throw new Error('private-canary ciphertext orders');
    }
    return read;
  }
  vi.spyOn(db, 'query').mockImplementation(race);
  if (kind === 'removed' || kind === 'demoted') {
    const response = await request();
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ status: 'refused' });
    expect(response.body + logs.join('')).not.toMatch(/orders|ciphertext|private-canary/u);
  } else {
    await result(kind === 'chat' ? 'absent_on_version' : 'unavailable');
  }
  expect(changed).toBe(true);
}
async function changedDuringRead(kind: string) {
  await racing(kind);
}
it.each(['rebuild', 'insertion', 'projected insertion', 'chat', 'removed', 'demoted'])(
  'checks %s during preparation before revealing metadata', changedDuringRead);
async function refusedFailure(kind: string, failure: string) {
  await racing(kind, failure);
}
it.each([['removed', 'lookup'], ['demoted', 'lookup'], ['removed', 'expired'],
  ['demoted', 'expired'], ['removed', 'inventory'], ['demoted', 'inventory']])(
  'refuses a %s caller even with %s preparation failure', refusedFailure);

async function laterChange(kind: string) {
  const inventory = await memberInventory(memberReads, 'alice', performance.now() + 10_000);
  expect(inventory.complete).toBe(true);
  const response = await request();
  const review = memberDepartureSchema.parse(response.json());
  if (kind === 'rebuild') {
    await rebuildRoutineProjection(db, nats.reader, logger, { verify: true });
  } else {
    await nats.seed([legacy()]);
    await project();
  }
  expect(await inventory.checkCurrent(performance.now() + 2_000, false)).toBe(false);
  const after = await memberInventory(memberReads, 'alice', performance.now() + 10_000);
  expect(after.reviewRevision).not.toBe(inventory.reviewRevision);
  const input = { commandId: 'remove-alice', expectedSequence: review.memberSequence,
    reviewRevision: review.reviewRevision };
  const before = await nats.store.head();
  await expect(removalCommand(memberReads, 'admin', 'alice', input)).rejects.toThrow();
  expect(await nats.store.head()).toBe(before);
}
it.each(['routine', 'rebuild'])('refuses an old review after a later %s change', laterChange);

async function latePreparation(kind: string) {
  await result('absent_on_version');
  const query = db.query.bind(db);
  let contentChecks = 0;
  async function race<Row extends Record<string, unknown>>(sql: string, values?: unknown[],
    options?: { deadline: number }) {
    const read = await query<Row>(sql, values, options);
    if (sql.includes('COALESCE(max(position), 0) FROM computers')) {
      contentChecks++;
      if (contentChecks === 3) {
        if (kind === 'rebuild') {
          await rebuildRoutineProjection(db, nats.reader, logger, { verify: true });
        } else {
          await nats.seed([legacy()]);
          await project();
        }
      }
    }
    return read;
  }
  vi.spyOn(db, 'query').mockImplementation(race);
  await result('unavailable');
  expect(contentChecks).toBe(3);
}
it.each(['routine', 'rebuild'])(
  'refuses absence after a %s change during the final content check', latePreparation);
