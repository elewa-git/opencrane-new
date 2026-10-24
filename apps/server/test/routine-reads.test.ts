import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { encodeSession } from '@opencrane/auth';
import { createStore, memberAuthorisation, rebuildMembers } from '@opencrane/authz';
import { event, natsFixture } from '@opencrane/event-store/testing';
import { openfga } from '../../../libs/authz/test/services.ts';
import { joinedMember, routine } from '../../../libs/authz/test/routine-fixture.ts';
import { objectId, TupleClient } from '../../../libs/authz/src/client.ts';
import { routineControlSchema, routineDefinitionSchema, getEventDefinition,
  type EventEnvelope } from '@opencrane/events';
import { routineMetadataSchema } from '../src/routine-read.ts';
import { buildServer } from '../src/server.ts';
import { testAuthConfig } from './support/test-auth-config.ts';

const config = testAuthConfig({ expectedOrgId: 'org-test' });
let nats: Awaited<ReturnType<typeof natsFixture>>;
let fga: Awaited<ReturnType<typeof openfga>>;
let binding: Awaited<ReturnType<typeof createStore>>;
let app: ReturnType<typeof buildServer>;
let logs: string[];
function write(line: string) {
  logs.push(line);
}
function noSql(): never {
  throw new Error('No database access during routine reads');
}
const db = { query: noSql };
function memberId(_silo: string, _issuer: string, sub: string) {
  return Promise.resolve(sub);
}
async function setup() {
  nats = await natsFixture();
  fga = await openfga();
  binding = await createStore(fga.apiUrl, 'test');
  const auth = memberAuthorisation(binding, nats.store);
  const members = ['alice', 'admin', 'bob'].map(joinedMember);
  const owner = event('joined-owner', 'member-owner');
  const ownerData = { ...owner.data, role: 'owner' };
  members.push({ ...owner, data: ownerData });
  const events = [...members, routine('routine.created')];
  await nats.seed(events);
  for (const record of events) {
    await auth.handler.handle(record, db);
  }
  const memberReads = { silo: 'test', store: nats.store, binding, db, feed: { memberId } };
  logs = [];
  app = buildServer(config, { memberReads, logDestination: { write } });
  app.log.level = 'info';
}
async function cleanup() {
  vi.restoreAllMocks();
  await app?.close();
  await fga?.close();
  await nats?.close();
}
beforeEach(setup, 30_000);
afterEach(cleanup);
function request(actor = 'alice', routineId = 'orders', orgId = 'org-test') {
  const session = { sub: actor, orgId, roles: [], authTime: 1790856000, exp: 2000000000 };
  const cookie = `${config.cookieName}=${encodeSession(config, session)}`;
  return app.inject({ method: 'GET', url: `/api/routines/${routineId}`, headers: { cookie } });
}
async function safeMetadata() {
  const response = await request();
  expect(response.statusCode).toBe(200);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.json()).toEqual({ routineId: 'orders', name: 'Daily orders',
    ownerId: 'alice', assistantId: 'sales-assistant', payingGroupId: 'sales',
    status: 'paused', definitionRevision: 1, scheduleRevision: 1, controlRevision: 1,
    next: { localDate: '2026-10-11', localTime: '09:00', zone: 'Europe/Brussels',
      at: '2026-10-11T07:00:00Z', offsetMinutes: 120 }, executionAvailable: false });
}
it('returns only saved safe metadata to the recorded owner', safeMetadata);

async function save(record: EventEnvelope, apply = true) {
  await nats.seed([record]);
  const auth = memberAuthorisation(binding, nats.store);
  if (apply && auth.handler.eventTypes.includes(record.type)) {
    await auth.handler.handle(record, db);
  }
}
async function permittedReader(actor: string) {
  const response = await request(actor);
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual((await request()).json());
}
it.each(['admin', 'owner'])('allows current silo %s to read the same safe facts', permittedReader);

async function refusedReader(actor: string) {
  const response = await request(actor);
  expect(response.statusCode).toBe(403);
  expect(response.json()).toEqual({ status: 'refused' });
  expect(response.headers['cache-control']).toBe('no-store');
}
it.each(['outsider', 'bob'])('refuses %s without leaking metadata', refusedReader);

async function transportChecks() {
  expect((await app.inject('/api/routines/orders')).statusCode).toBe(401);
  expect((await request('alice', 'orders', 'foreign')).statusCode).toBe(403);
  expect((await request('alice', 'bad.id')).statusCode).toBe(400);
  const foreign = { ...binding, silo: 'foreign' };
  const memberReads = { silo: 'test', store: nats.store, binding: foreign,
    db, feed: { memberId } };
  await app.close();
  app = buildServer(config, { memberReads });
  expect((await request()).statusCode).toBe(403);
  await app.close();
  app = buildServer(config);
  expect((await request()).statusCode).toBe(503);
}
it('requires sign-in, the configured organisation, valid ids and matching silo bindings',
  transportChecks);

async function missingAndLegacy() {
  const legacy = { ...routine('routine.created'), id: 'legacy', commandId: 'legacy',
    subject: 'routine-old', data: { routineId: 'old', assistantId: 'assistant',
      schedule: '* * * * *', createdBy: 'alice' } };
  await save(legacy);
  for (const routineId of ['missing', 'old']) {
    const response = await request('admin', routineId);
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ status: 'refused' });
  }
}
it('grants no permission from missing or legacy routine records', missingAndLegacy);

async function reassign() {
  const reassigned = routine('routine.reassigned', 'bob');
  await save(reassigned, false);
  await refusedReader('alice');
  await refusedReader('bob');
  const auth = memberAuthorisation(binding, nats.store);
  await auth.handler.handle(reassigned, db);
  const client = new TupleClient(binding);
  const staleOwner = { user: objectId('person', 'test', 'alice'), relation: 'owner',
    object: objectId('routine', 'test', 'orders') };
  await client.write([staleOwner], []);
  await refusedReader('alice');
  const response = await request('bob');
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ ownerId: 'bob', status: 'paused',
    definitionRevision: 2, controlRevision: 2, executionAvailable: false });
}
it('requires exact IAM receipts and defeats a stale owner tuple after reassignment', reassign);

async function removedReader() {
  const removed = event('removed-alice', 'member-alice', 'member.removed');
  await save(removed, false);
  await refusedReader('alice');
}
it('refuses saved removal before IAM catches up', removedReader);

async function retiredAndRebuilt() {
  await save(routine('routine.retired'));
  const before = await request();
  expect(before.statusCode).toBe(200);
  expect(before.json()).toMatchObject({ status: 'retired', controlRevision: 2,
    next: null, executionAvailable: false });
  expect((await request('admin')).json()).toEqual(before.json());
  const position = await nats.store.head();
  const append = vi.spyOn(nats.store, 'append');
  const rebuilt = await rebuildMembers(fga.apiUrl, 'test', nats.reader);
  const memberReads = { silo: 'test', store: nats.store, binding: rebuilt.binding,
    db, feed: { memberId } };
  await app.close();
  app = buildServer(config, { memberReads });
  expect((await request()).json()).toEqual(before.json());
  expect((await request('admin')).json()).toEqual(before.json());
  expect(append).not.toHaveBeenCalled();
  expect(await nats.store.head()).toBe(position);
}
it('keeps retired metadata readable after rebuilding permissions without saving work',
  retiredAndRebuilt);

async function duringHistory(fails: boolean) {
  const read = nats.store.readStream.bind(nats.store);
  async function* remove(subject: string, from?: number, deadline?: number) {
    yield* read(subject, from, deadline);
    if (subject === 'routine-orders') {
      await save(event('removed-alice', 'member-alice', 'member.removed'), false);
      if (fails) {
        throw new Error('private-result-canary key:1 ZmFrZS1jaXBoZXJ0ZXh0');
      }
    }
  }
  vi.spyOn(nats.store, 'readStream').mockImplementation(remove);
  await refusedReader('alice');
  expect(logs.join('')).not.toMatch(/private-result-canary|key:1|ZmFrZS1jaXBoZXJ0ZXh0/u);
}
it.each([false, true])('refuses removal during history even when loading fails: %s', duringHistory);

const failedHistoryReaders = [
  { actor: 'bob', formerOwner: false, partialHistory: false },
  { actor: 'bob', formerOwner: false, partialHistory: true },
  { actor: 'alice', formerOwner: true, partialHistory: false },
  { actor: 'alice', formerOwner: true, partialHistory: true },
];
async function refusedFailedHistory(testCase: typeof failedHistoryReaders[number]) {
  if (testCase.formerOwner) {
    await save(routine('routine.reassigned', 'bob'));
  }
  const missing = await request(testCase.actor, 'missing');
  expect(missing.statusCode).toBe(403);
  expect(missing.json()).toEqual({ status: 'refused' });
  const read = nats.store.readStream.bind(nats.store);
  async function* fail(subject: string, from?: number, deadline?: number) {
    if (subject === 'routine-orders') {
      if (testCase.partialHistory) {
        yield* read(subject, from, deadline);
      }
      throw new Error('History deadline exceeded with private-result-canary');
    }
    yield* read(subject, from, deadline);
  }
  vi.spyOn(nats.store, 'readStream').mockImplementation(fail);
  const response = await request(testCase.actor);
  expect(response.statusCode).toBe(403);
  expect(response.json()).toEqual({ status: 'refused' });
  expect(response.body).toBe(missing.body);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(logs.join('') + response.body).not.toContain('private-result-canary');
}
it.each(failedHistoryReaders)(
  'refuses $actor after history fails like a missing id, former owner: $formerOwner, partial: $partialHistory',
  refusedFailedHistory);

async function unavailable(source: string) {
  if (source === 'IAM') {
    await fga.pause();
  } else {
    const read = nats.store.readStream.bind(nats.store);
    async function* fail(subject: string, from?: number, deadline?: number) {
      if (subject === 'routine-orders') {
        throw new Error('instructions-canary private-result-canary key:1');
      }
      yield* read(subject, from, deadline);
    }
    vi.spyOn(nats.store, 'readStream').mockImplementation(fail);
  }
  const response = await request();
  expect(response.statusCode).toBe(503);
  expect(response.json()).toEqual({ status: 'unavailable' });
  expect(logs.join('') + response.body).not.toMatch(/instructions-canary|private-result|key:1/u);
  if (source === 'IAM') {
    await fga.resume();
  }
}
it.each(['history', 'IAM'])('reports %s outages as unavailable without private errors', unavailable);

async function slowHistory() {
  const read = nats.store.readStream.bind(nats.store);
  const now = performance.now.bind(performance);
  let elapsed = 0;
  function clock() {
    return now() + elapsed;
  }
  vi.spyOn(performance, 'now').mockImplementation(clock);
  async function* slow(subject: string, from?: number, deadline?: number) {
    expect(deadline).toBeGreaterThan(clock() + 9000);
    expect(subject).toMatch(/^(routine-orders|member-alice|ownership-test)$/u);
    yield* read(subject, from, deadline);
    if (subject === 'routine-orders') {
      elapsed += 3000;
      const chat: EventEnvelope = event('unrelated', 'conversation-unrelated', 'message.posted');
      chat.data = { conversationId: 'unrelated', authorId: 'alice', authorKind: 'human',
        ciphertext: 'ZmFrZS1jaXBoZXJ0ZXh0', keyId: 'key:1' };
      await nats.seed([chat]);
    }
  }
  const reads = vi.spyOn(nats.store, 'readStream').mockImplementation(slow);
  const heads = vi.spyOn(nats.store, 'head');
  await safeMetadata();
  expect(reads.mock.calls).toHaveLength(3);
  expect(heads).not.toHaveBeenCalled();
}
it('loads exact history once with its own bound; slow history and chat do not deny', slowHistory);

async function privateRunFacts() {
  const saved = routine('routine.created');
  if (!saved.data || typeof saved.data !== 'object') {
    throw new Error('Missing fixture definition');
  }
  const definition = routineDefinitionSchema.parse(Reflect.get(saved.data, 'definition'));
  const updated = { ...saved, id: 'active', commandId: 'active', type: 'routine.updated',
    data: { ...saved.data, definition, status: 'active' } };
  await save(updated);
  const due = { ...event('due', 'routine-orders', 'routine.due'), source: 'opencrane-server',
    principal: { kind: 'system' as const, id: 'opencrane-server' },
    data: getEventDefinition('routine.due')!.example };
  await save(due);
  const finishedData = getEventDefinition('routine.run_finished')!.example;
  if (!finishedData || typeof finishedData !== 'object') {
    throw new Error('Missing fixture result');
  }
  const finished = { ...due, id: 'finished', commandId: 'finished', type: 'routine.run_finished',
    data: { ...finishedData,
      resultReference: { eventId: 'private-result-canary', position: 1 } } };
  await save(finished);
  const append = vi.spyOn(nats.store, 'append');
  const response = await request('admin');
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ status: 'active', executionAvailable: false });
  expect(logs.join('') + response.body).not.toMatch(
    /instructions|ciphertext|ZmFrZS1jaXBoZXJ0ZXh0|key:1|private-result|conversationId|orders-bot/u);
  expect(append).not.toHaveBeenCalled();
  const metadata = response.json<Record<string, unknown>>();
  expect(routineMetadataSchema.safeParse({ ...metadata, instructions: 'canary' }).success).toBe(false);
  const next = routineControlSchema.parse(getEventDefinition('routine.paused')!.example).next;
  expect(routineMetadataSchema.safeParse({ ...metadata, next: { ...next, secretRef: 'canary' } })
    .success).toBe(false);
}
it('excludes encrypted instructions, custody and private runs and rejects extra output fields',
  privateRunFacts);

async function exceededHistoryBound() {
  const read = nats.store.readStream.bind(nats.store);
  async function* expire(subject: string, from?: number, deadline?: number) {
    if (subject === 'routine-orders') {
      expect(deadline).toBeLessThanOrEqual(performance.now() + 10_000);
      expect(deadline).toBeGreaterThan(performance.now() + 9000);
      throw new Error('History deadline exceeded with instructions-canary');
    }
    yield* read(subject, from, deadline);
  }
  const reads = vi.spyOn(nats.store, 'readStream').mockImplementation(expire);
  const response = await request();
  expect(response.statusCode).toBe(503);
  expect(response.json()).toEqual({ status: 'unavailable' });
  expect(reads.mock.calls).toHaveLength(3);
  expect(reads.mock.calls[1]?.[0]).toBe('member-alice');
  expect(reads.mock.calls[2]?.[0]).toBe('ownership-test');
}
it('checks current membership once after bounded history fails', exceededHistoryBound);

async function demotedAdmin() {
  const demotion = { ...event('demoted', 'member-admin', 'member.role_changed'),
    data: { memberId: 'admin', previousRole: 'admin', newRole: 'member', changedBy: 'owner' } };
  await save(demotion, false);
  await refusedReader('admin');
  const auth = memberAuthorisation(binding, nats.store);
  await auth.handler.handle(demotion, db);
  await refusedReader('admin');
}
it('refuses a former admin before and after permission updates', demotedAdmin);

async function foreignHistory() {
  const read = nats.store.readStream.bind(nats.store);
  async function* foreign(subject: string, from?: number, deadline?: number) {
    for await (const row of read(subject, from, deadline)) {
      if (subject === 'routine-orders') {
        yield { ...row, event: { ...row.event, silo: 'foreign' } };
      } else {
        yield row;
      }
    }
  }
  vi.spyOn(nats.store, 'readStream').mockImplementation(foreign);
  const response = await request();
  expect(response.statusCode).toBe(503);
  expect(response.json()).toEqual({ status: 'unavailable' });
}
it('refuses history from a foreign silo even when local permission tuples allow it', foreignHistory);
