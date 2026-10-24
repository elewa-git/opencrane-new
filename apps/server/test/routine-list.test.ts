import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { encodeSession } from '@opencrane/auth';
import { createStore, memberAuthorisation } from '@opencrane/authz';
import { event, natsFixture } from '@opencrane/event-store/testing';
import type { EventEnvelope } from '@opencrane/events';
import * as models from '@opencrane/models';
import { createLogger } from '@opencrane/observability';
import { ProjectionRunner, rebuildRoutineProjection, routines,
  type Db, type Query } from '@opencrane/projections';
import { openfga } from '../../../libs/authz/test/services.ts';
import { joinedMember, routine } from '../../../libs/authz/test/routine-fixture.ts';
import { database } from '../../../libs/projections/test/database.ts';
import { conversationListCursor } from '../src/chat/list-cursor.ts';
import { routineMetadataSchema } from '../src/routine-read.ts';
import { buildServer } from '../src/server.ts';
import { testAuthConfig } from './support/test-auth-config.ts';

const config = testAuthConfig({ expectedOrgId: 'org-test' });
const logger = createLogger('routine-list-test', { level: 'silent' });
let nats: Awaited<ReturnType<typeof natsFixture>>;
let fga: Awaited<ReturnType<typeof openfga>>;
let storage: Awaited<ReturnType<typeof database>>;
let binding: Awaited<ReturnType<typeof createStore>>;
let runner: ProjectionRunner;
let app: ReturnType<typeof buildServer>;
let db: Db;
let logs: string[];
function write(line: string) { logs.push(line); }
function memberId(_silo: string, _issuer: string, sub: string) { return Promise.resolve(sub); }
function record(id: string, owner = 'alice', type = 'routine.created') {
  const saved = routine(type, owner, `${type}-${id}`);
  if (!saved.data || typeof saved.data !== 'object') throw new Error('Missing fixture data');
  const data = { ...saved.data, routineId: id };
  return { ...saved, subject: `routine-${id}`, data };
}
async function save(saved: EventEnvelope, iam = true, project = true) {
  await nats.seed([saved]);
  const auth = memberAuthorisation(binding, nats.store);
  if (iam && auth.handler.eventTypes.includes(saved.type)) await auth.handler.handle(saved, db);
  if (project) await runner.run(routines);
}
async function setup() {
  logs = [];
  storage = await database('pg');
  db = storage.db;
  nats = await natsFixture();
  fga = await openfga();
  binding = await createStore(fga.apiUrl, 'test');
  runner = new ProjectionRunner(db, nats.reader, logger);
  await runner.initialise(routines);
  for (const actor of ['alice', 'admin', 'bob']) await save(joinedMember(actor));
  const memberReads = { silo: 'test', store: nats.store, binding, db, feed: { memberId } };
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
function request(query = '', actor = 'alice', orgId = 'org-test', view = 'mine') {
  const session = { sub: actor, orgId, roles: [], authTime: 1790856000, exp: 2000000000 };
  const headers = { cookie: `${config.cookieName}=${encodeSession(config, session)}` };
  return app.inject({ method: 'GET', url: `/api/routines?view=${view}&${query}`, headers });
}
type Page = { rows: Record<string, unknown>[]; next: string | null;
  complete: boolean; executionAvailable: false };
async function page(query = '', actor = 'alice', view = 'mine') {
  const response = await request(query, actor, 'org-test', view);
  expect(response.statusCode).toBe(200);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.body + logs.join('')).not.toMatch(
    /private-canary|ciphertext|key:1|orders-bot|conversationId|resultReference|Cents/u);
  const result = response.json<Page>();
  expect(result.executionAvailable).toBe(false);
  const fields = Object.keys(result);
  fields.sort();
  expect(fields).toEqual(
    ['complete', 'executionAvailable', 'generation', 'next', 'rows', 'sequence']);
  for (const row of result.rows) expect(routineMetadataSchema.safeParse(row).success).toBe(true);
  return result;
}
function identity(row: Record<string, unknown>) { return row['routineId']; }
async function boundedPages() {
  const expected = ['retired'];
  await save({ ...record('foreign'), silo: 'foreign' }, false);
  await save(record('retired'));
  await save(record('retired', 'alice', 'routine.retired'));
  for (let index = 0; index < 55; index++) {
    const id = `own-${index}`;
    await save(record(id));
    await save(record(`other-${index}`, 'bob'));
    expected.push(id);
  }
  const position = await nats.store.head();
  const append = vi.spyOn(nats.store, 'append');
  const approval = vi.spyOn(models, 'readApproval');
  const originalQuery = db.query.bind(db);
  async function boundedQuery<Row extends Record<string, unknown>>(sql: string, values?: unknown[],
    options?: { deadline: number }) {
    const result = await originalQuery<Row>(sql, values, options);
    if (sql.includes('FROM routines WHERE')) {
      expect(result.rows.length).toBeLessThanOrEqual(Number(values?.at(-1)));
      expect(result.rows.length).toBeLessThanOrEqual(51);
      for (const row of result.rows) {
        expect(row['ownerId']).toBe('alice');
        expect(row).not.toHaveProperty('state');
      }
    }
    return result;
  }
  vi.spyOn(db, 'query').mockImplementation(boundedQuery);
  const read = nats.store.readStream.bind(nats.store);
  async function* limited(subject: string, from?: number, deadline?: number) {
    expect(subject).not.toMatch(/conversation|\*/u);
    expect(subject).not.toMatch(/^routine-other-/u);
    yield* read(subject, from, deadline);
  }
  vi.spyOn(nats.store, 'readStream').mockImplementation(limited);
  const first = await page('limit=50');
  expect(first.rows).toHaveLength(50);
  expect(first.complete).toBe(false);
  const last = await page(`limit=50&continuation=${first.next}`);
  const rows = [...first.rows, ...last.rows];
  expect(rows.map(identity)).toEqual(expected);
  expect(rows[0]).toMatchObject({ status: 'retired' });
  expect(last.next).toBeNull();
  expect(last.complete).toBe(true);
  expect((await page()).rows).toHaveLength(20);
  expect((await page('', 'admin')).rows).toEqual([]);
  await rebuildRoutineProjection(db, nats.reader, logger, { verify: true });
  expect((await page('limit=50')).rows).toEqual(first.rows);
  expect((await request(`limit=50&continuation=${first.next}`)).statusCode).toBe(409);
  expect(append).not.toHaveBeenCalled();
  expect(approval).not.toHaveBeenCalled();
  expect(await nats.store.head()).toBe(position);
}
it('pages over fifty own routines among other owners, including retirement, without effects',
  boundedPages, 60_000);
async function filteredPages(view: string, actor: string) {
  await save(record('first'));
  await save(record('denied'), false);
  await save(record('last'));
  const first = await page('limit=1', actor, view);
  const middle = await page(`limit=1&continuation=${first.next}`, actor, view);
  expect(middle.rows).toEqual([]);
  expect(JSON.stringify(middle)).not.toContain('denied');
  expect(middle.complete).toBe(false);
  expect(middle.next).not.toBeNull();
  const last = await page(`limit=1&continuation=${middle.next}`, actor, view);
  expect(last.rows.map(identity)).toEqual(['last']);
  expect(last.next).toBeNull();
  await save(record('denied-end'), false);
  const refreshed = await page('limit=3', actor, view);
  const end = await page(`limit=3&continuation=${refreshed.next}`, actor, view);
  expect(end.rows).toEqual([]);
  expect(end.next).toBeNull();
  expect(end.complete).toBe(false);
}
it.each([['mine', 'alice'], ['all', 'admin']])(
  'retains continuation on an empty filtered %s intermediate page', filteredPages);
async function continuations(view: string, actor: string) {
  await save(record('first'));
  await save(record('last'));
  const joined = event('joined-other-admin', 'member-other-admin');
  const otherAdmin = { ...joined, data: { ...joined.data, role: 'admin' } };
  await save(otherAdmin);
  const first = await page('limit=1', actor, view);
  const foreign = conversationListCursor(config.cookieSecret,
    ['routine-list', 'foreign', actor, view, 1, await nats.store.head('routine-*')]);
  for (const continuation of ['changed', `${first.next}x`, foreign.next([0, 1])]) {
    const changed = await request(`limit=1&continuation=${continuation}`, actor, 'org-test', view);
    expect(changed.statusCode).toBe(409);
  }
  const query = `limit=1&continuation=${first.next}`;
  const otherMember = await request(query, 'other-admin', 'org-test', view);
  expect(otherMember.statusCode).toBe(409);
  const otherLimit = await request(`limit=2&continuation=${first.next}`, actor, 'org-test', view);
  expect(otherLimit.statusCode).toBe(409);
  await save(event('chat', 'conversation-busy'), false, false);
  const afterChat = await page(query, actor, view);
  expect(afterChat.rows.map(identity)).toEqual(['last']);
  await save(record('new'));
  const stale = await request(query, actor, 'org-test', view);
  expect(stale.statusCode).toBe(409);
}
it.each([['mine', 'alice'], ['all', 'admin']])(
  'binds %s continuations to member, silo, query and routine changes but ignores chat activity',
  continuations);
async function unreadableRoutineChanges(duringLoading: boolean) {
  await save(record('first'));
  await save(record('middle'));
  await save(record('last'));
  await save(record('private', 'bob'));
  const session = { sub: 'alice', orgId: 'org-test', roles: [],
    authTime: 1790856000, exp: 2000000000 };
  const headers = { cookie: `${config.cookieName}=${encodeSession(config, session)}` };
  const denied = await app.inject({ method: 'GET', url: '/api/routines/private', headers });
  expect(denied.statusCode).toBe(403);
  const first = await page('limit=1');
  const query = `limit=1&continuation=${first.next}`;
  const before = await page(query);
  expect(before.rows.map(identity)).toEqual(['middle']);
  expect(before.next).not.toBeNull();
  if (duringLoading) {
    const original = db.query.bind(db);
    let progressReads = 0;
    async function retireDuringLoading<Row extends Record<string, unknown>>(
      sql: string, values?: unknown[], options?: { deadline: number }) {
      const result = await original<Row>(sql, values, options);
      if (sql.includes('JOIN projection_generations')) {
        progressReads += 1;
        if (progressReads === 2) {
          await save(record('private', 'bob', 'routine.retired'));
        }
      }
      return result;
    }
    vi.spyOn(db, 'query').mockImplementation(retireDuringLoading);
  } else {
    await save(record('private', 'bob', 'routine.retired'));
  }
  const after = await page(query);
  expect(after).toEqual(before);
  expect((await page('limit=1')).next).toBe(first.next);
}
it.each([false, true])(
  'keeps the exact HTTP page when an unreadable routine changes (during loading: %s)',
  unreadableRoutineChanges);

async function transport() {
  expect((await app.inject('/api/routines?view=mine')).statusCode).toBe(401);
  expect((await request('', 'alice', 'foreign')).statusCode).toBe(403);
  expect((await request('', 'outsider')).statusCode).toBe(403);
  for (const query of ['limit=51', 'limit=0', 'limit=1.5', 'limit=2&limit=3',
    'ownerId=bob', 'view=all', 'extra=1']) {
    expect((await request(query)).statusCode).toBe(400);
  }
}
it('requires membership and valid bounds without an owner parameter', transport);
async function unavailable(kind: string, view: string) {
  if (kind === 'missing') await db.query('DROP TABLE routines');
  if (kind === 'lagging') await save(record('pending'), true, false);
  if (kind === 'generation') await db.query('DELETE FROM projection_generations');
  if (kind === 'checkpoint') await db.query('DELETE FROM projection_checkpoints');
  const response = await request('', 'admin', 'org-test', view);
  expect(response.statusCode).toBe(503);
  expect(response.json()).toEqual({ status: 'unavailable' });
}
it.each([['missing', 'mine'], ['lagging', 'mine'], ['generation', 'mine'],
  ['checkpoint', 'mine'], ['missing', 'all'], ['lagging', 'all'],
  ['generation', 'all'], ['checkpoint', 'all']])(
  'never calls a %s projection empty', unavailable);
async function locked(view: string) {
  const acquired = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  async function hold(tx: Query) {
    await tx.query('LOCK TABLE routines IN ACCESS EXCLUSIVE MODE');
    acquired.resolve();
    await release.promise;
  }
  const pending = db.transaction(hold);
  await acquired.promise;
  try {
    expect((await request('', 'admin', 'org-test', view)).statusCode).toBe(503);
  } finally {
    release.resolve();
    await pending;
  }
  expect((await page('', 'admin', view)).complete).toBe(true);
}
it.each(['mine', 'all'])('bounds a locked %s candidate query', locked, 15_000);
async function duringPage(kind: string) {
  await save(record('orders'));
  const original = db.query.bind(db);
  let progressReads = 0;
  async function query<Row extends Record<string, unknown>>(sql: string, values?: unknown[],
    options?: { deadline: number }) {
    const result = await original<Row>(sql, values, options);
    if (sql.includes('JOIN projection_generations')) {
      progressReads += 1;
      if (progressReads === 2 && kind === 'remove-final') {
        await save(event('removed', 'member-alice', 'member.removed'), false, false);
        throw new Error('private-canary');
      }
      if (progressReads === 2 && kind === 'reassign-final') {
        await save(record('orders', 'bob', 'routine.reassigned'), false, false);
      }
    }
    if (sql.includes('FROM routines AS owned')) {
      expect(values).toEqual(['test', 'alice']);
      expect(result.rows.length).toBeLessThanOrEqual(1);
    }
    if (sql.includes('FROM routines WHERE')) {
      expect(values).toEqual(['test', 'alice', 0, 21]);
      expect(result.rows.length).toBeLessThanOrEqual(21);
      if (kind === 'reassign') await save(record('orders', 'bob', 'routine.reassigned'), false, false);
      if (kind === 'remove' || kind === 'remove-failed') {
        await save(event('removed', 'member-alice', 'member.removed'), false, false);
      }
      if (kind === 'remove-failed') throw new Error('private-canary');
      if (kind === 'rebuild') await rebuildRoutineProjection(db, nats.reader, logger);
    }
    return result;
  }
  vi.spyOn(db, 'query').mockImplementation(query);
  const response = await request();
  const expected: Record<string, number> = { reassign: 409, remove: 403,
    'remove-failed': 403, rebuild: 409, 'remove-final': 403, 'reassign-final': 409 };
  expect(response.statusCode).toBe(expected[kind]);
  expect(response.body + logs.join('')).not.toMatch(/Daily orders|private-canary/u);
}
it.each(['reassign', 'remove', 'remove-failed', 'rebuild', 'remove-final', 'reassign-final'])(
  'suppresses protected rows after %s during loading with stale IAM', duringPage);
async function slowHistory(view: string, actor: string) {
  await save(record('orders'));
  const read = nats.store.readStream.bind(nats.store);
  const now = performance.now.bind(performance);
  let elapsed = 0;
  function clock() { return now() + elapsed; }
  vi.spyOn(performance, 'now').mockImplementation(clock);
  async function* slow(subject: string, from?: number, deadline?: number) {
    expect(subject).toMatch(/^(routine-orders|member-alice|member-admin|ownership-test)$/u);
    expect(deadline).toBeGreaterThan(clock());
    yield* read(subject, from, deadline);
    if (subject === 'routine-orders') {
      await save(event('busy-chat', 'conversation-busy'), false, false);
      elapsed += 3000;
    }
  }
  vi.spyOn(nats.store, 'readStream').mockImplementation(slow);
  expect((await page('', actor, view)).rows).toHaveLength(1);
}
it.each([['mine', 'alice'], ['all', 'admin']])(
  'keeps %s access after slow preparatory history without reading chats', slowHistory);
async function reassignedAdmin(changingDuring: string) {
  await save(record('orders', 'admin'));
  await save(record('later', 'admin'));
  expect((await page('', 'admin')).rows.map(identity)).toEqual(['orders', 'later']);
  expect((await page()).rows).toEqual([]);
  const read = nats.store.readStream.bind(nats.store);
  async function* replace(subject: string, from?: number, deadline?: number) {
    if (subject === `routine-${changingDuring}`) {
      await save(record('orders', 'bob', 'routine.reassigned'), false, false);
    }
    yield* read(subject, from, deadline);
  }
  vi.spyOn(nats.store, 'readStream').mockImplementation(replace);
  const response = await request('', 'admin');
  expect(response.statusCode).toBe(409);
  expect(response.body).not.toContain('Daily orders');
}
it.each(['orders', 'later'])(
  'suppresses an admin-owned routine reassigned while loading %s history', reassignedAdmin);

async function failedHistory() {
  await save(record('orders'));
  const read = nats.store.readStream.bind(nats.store);
  async function* fail(subject: string, from?: number, deadline?: number) {
    if (subject === 'routine-orders') throw new Error('private-canary');
    yield* read(subject, from, deadline);
  }
  vi.spyOn(nats.store, 'readStream').mockImplementation(fail);
  expect((await request()).json()).toEqual({ status: 'unavailable' });
  await save(event('removed', 'member-alice', 'member.removed'), false, false);
  expect((await request()).json()).toEqual({ status: 'refused' });
  expect(logs.join('')).not.toContain('private-canary');
}
it('checks current access after routine history fails without exposing the cause', failedHistory);

async function adminPages() {
  const foreign = { ...record('foreign'), silo: 'foreign' };
  await save(foreign, false);
  await save(record('retired', 'bob'));
  await save(record('retired', 'bob', 'routine.retired'));
  await save(record('admin-own', 'admin'));
  const expected = ['retired', 'admin-own'];
  for (let index = 0; index < 25; index++) {
    for (const owner of ['alice', 'bob']) {
      const id = `${owner}-${index}`;
      await save(record(id, owner));
      expected.push(id);
    }
  }
  const position = await nats.store.head();
  const append = vi.spyOn(nats.store, 'append');
  const approval = vi.spyOn(models, 'readApproval');
  const originalQuery = db.query.bind(db);
  async function boundedQuery<Row extends Record<string, unknown>>(sql: string, values?: unknown[],
    options?: { deadline: number }) {
    const result = await originalQuery<Row>(sql, values, options);
    if (sql.includes('FROM routines WHERE')) {
      expect(values).toEqual(['test', expect.any(Number), expect.any(Number)]);
      expect(result.rows.length).toBeLessThanOrEqual(Number(values?.at(-1)));
      expect(result.rows.length).toBeLessThanOrEqual(51);
      for (const row of result.rows) expect(row).not.toHaveProperty('state');
    }
    return result;
  }
  const querySpy = vi.spyOn(db, 'query');
  querySpy.mockImplementation(boundedQuery);
  const first = await page('limit=50', 'admin', 'all');
  expect(first.rows).toHaveLength(50);
  expect(first.complete).toBe(false);
  const last = await page(`limit=50&continuation=${first.next}`, 'admin', 'all');
  const rows = [...first.rows, ...last.rows];
  expect(rows.map(identity)).toEqual(expected);
  expect(rows[0]).toMatchObject({ status: 'retired', ownerId: 'bob' });
  expect(last).toMatchObject({ next: null, complete: true });
  expect((await page('', 'admin', 'all')).rows).toHaveLength(20);
  querySpy.mockRestore();
  expect((await page('', 'admin')).rows.map(identity)).toEqual(['admin-own']);
  await rebuildRoutineProjection(db, nats.reader, logger, { verify: true });
  expect((await page('limit=50', 'admin', 'all')).rows).toEqual(first.rows);
  const stale = await request(`limit=50&continuation=${first.next}`, 'admin', 'org-test', 'all');
  expect(stale.statusCode).toBe(409);
  expect(append).not.toHaveBeenCalled();
  expect(approval).not.toHaveBeenCalled();
  expect(await nats.store.head()).toBe(position);
}
it('pages admin metadata across owners and retired routines without effects', adminPages, 60_000);

async function adminAccess(change: string, load: string) {
  let actor = 'admin';
  if (change === 'member') actor = 'alice';
  if (load !== 'empty') await save(record('orders'));
  const original = db.query.bind(db);
  async function loadWithAccessChange<Row extends Record<string, unknown>>(
    sql: string, values?: unknown[], options?: { deadline: number }) {
    const result = await original<Row>(sql, values, options);
    if (!sql.includes('FROM routines WHERE')) return result;
    if (change === 'remove') {
      await save(event('removed', 'member-admin', 'member.removed'), false, false);
    }
    if (change === 'demote') {
      const demotion = { ...event('demoted', 'member-admin', 'member.role_changed'),
        data: { memberId: 'admin', previousRole: 'admin', newRole: 'member', changedBy: 'owner' } };
      await save(demotion, false, false);
    }
    if (load === 'failed') throw new Error('private-canary');
    if (load === 'malformed') Reflect.set(result.rows[0]!, 'name', null);
    return result;
  }
  const querySpy = vi.spyOn(db, 'query');
  querySpy.mockImplementation(loadWithAccessChange);
  const response = await request('', actor, 'org-test', 'all');
  expect(response.statusCode).toBe(403);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.json()).toEqual({ status: 'refused' });
  expect(response.body + logs.join('')).not.toMatch(/Daily orders|orders|private-canary/u);
}
it.each([['member', 'empty'], ['member', 'rows'], ['member', 'failed'], ['member', 'malformed'],
  ['demote', 'empty'], ['demote', 'rows'], ['demote', 'failed'], ['demote', 'malformed'],
  ['remove', 'empty'], ['remove', 'rows'], ['remove', 'failed'], ['remove', 'malformed']])(
  'refuses all after %s with stale IAM and a %s load', adminAccess);

async function allReassignment(stage: string) {
  await save(record('orders'));
  const original = db.query.bind(db);
  let progressReads = 0;
  let changed = false;
  async function reassign<Row extends Record<string, unknown>>(sql: string, values?: unknown[],
    options?: { deadline: number }) {
    const result = await original<Row>(sql, values, options);
    if (sql.includes('JOIN projection_generations')) progressReads += 1;
    const candidates = stage === 'candidates' && sql.includes('FROM routines WHERE');
    const final = stage === 'final' && progressReads === 2;
    if (!changed && (candidates || final)) {
      changed = true;
      await save(record('orders', 'bob', 'routine.reassigned'), false, false);
    }
    return result;
  }
  const querySpy = vi.spyOn(db, 'query');
  querySpy.mockImplementation(reassign);
  const response = await request('', 'admin', 'org-test', 'all');
  expect(response.statusCode).toBe(409);
  expect(response.json()).toEqual({ status: 'restart' });
  expect(response.body + logs.join('')).not.toContain('Daily orders');
}
it.each(['candidates', 'final'])('suppresses stale admin rows after reassignment at %s',
  allReassignment);

async function viewContinuations() {
  await save(record('first', 'admin'));
  await save(record('last', 'admin'));
  const mine = await page('limit=1', 'admin');
  const all = await page('limit=1', 'admin', 'all');
  expect(all.rows).toEqual(mine.rows);
  const intoMine = await request(`limit=1&continuation=${all.next}`, 'admin');
  const intoAll = await request(`limit=1&continuation=${mine.next}`, 'admin', 'org-test', 'all');
  expect(intoMine.statusCode).toBe(409);
  expect(intoAll.statusCode).toBe(409);
}
it('never accepts an all continuation for mine or a mine continuation for all', viewContinuations);

async function ownerList() {
  const joined = event('joined-owner', 'member-owner');
  const owner = { ...joined, data: { ...joined.data, role: 'owner' } };
  await save(owner);
  expect(await page('', 'owner', 'all')).toMatchObject({ rows: [], complete: true });
  await save(record('orders', 'bob'));
  expect((await page('', 'owner', 'all')).rows.map(identity)).toEqual(['orders']);
}
it('lets a current silo Owner read an empty or populated all list', ownerList);
