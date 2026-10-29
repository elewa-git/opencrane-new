import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createStore, memberAuthorisation } from '@opencrane/authz';
import type { AppendCommand, StoredEvent } from '@opencrane/event-store';
import { event } from '@opencrane/event-store/testing';
import { foldRoutine, getEventDefinition, type EventEnvelope, type RoutineState } from '@opencrane/events';
import { readRootStopEvidence } from '@opencrane/models';
import { openfga } from '../../../libs/authz/test/services.ts';
import { joinedMember, routine } from '../../../libs/authz/test/routine-fixture.ts';
import { shortDuplicateWindowFixture, waitForDuplicateWindow }
  from './support/duplicate-window.ts';
import { pauseRoutineAsAdmin } from '../src/routine-admin-pause.ts';

let nats: Awaited<ReturnType<typeof shortDuplicateWindowFixture>>;
let fga: Awaited<ReturnType<typeof openfga>>;
let binding: Awaited<ReturnType<typeof createStore>>;
let input: { changeId: string; routineId: string; expectedPosition: number;
  expectedDefinitionRevision: number; expectedScheduleRevision: number;
  expectedControlRevision: number };
function noSql(): never {
  throw new Error('No SQL writes');
}
const db = { query: noSql };

async function setup() {
  nats = await shortDuplicateWindowFixture();
  fga = await openfga();
  binding = await createStore(fga.apiUrl, 'test');
  const auth = memberAuthorisation(binding, nats.store);
  const members = ['alice', 'admin', 'bob'].map(joinedMember);
  const created = routine('routine.created');
  if (!created.data || typeof created.data !== 'object') {
    throw new Error('Missing definition');
  }
  const saved = { ...created, data: { ...created.data, status: 'active' } };
  const events = [...members, saved];
  await nats.seed(events);
  for (const record of events) {
    await auth.handler.handle(record, db);
  }
  input = { changeId: 'orders:pause-1', routineId: 'orders',
    expectedPosition: await nats.store.head('routine-orders'),
    expectedDefinitionRevision: 1, expectedScheduleRevision: 1, expectedControlRevision: 1 };
}
async function cleanup() {
  vi.restoreAllMocks();
  await fga?.close();
  await nats?.close();
}
beforeEach(setup, 30_000);
afterEach(cleanup);

async function rows() {
  const saved: StoredEvent[] = [];
  for await (const row of nats.store.readStream('routine-orders')) {
    saved.push(row);
  }
  return saved;
}
function pause(memberId = 'admin', request: unknown = input) {
  return pauseRoutineAsAdmin(nats.store, binding, memberId, request);
}
async function occupy() {
  const type = 'routine.due';
  const saved = { ...event('occupied', 'routine-orders', type), source: 'opencrane-server',
    principal: { kind: 'system' as const, id: 'opencrane-server' },
    data: getEventDefinition(type)!.example };
  await nats.seed([saved]);
  input.expectedPosition = await nats.store.head('routine-orders');
  return saved;
}

async function savesAdminPause() {
  const occupied = await occupy();
  const before = await nats.store.head();
  const [first, concurrent] = await Promise.all([pause(), pause()]);
  expect(concurrent).toEqual(first);
  expect(await pause()).toEqual(first);
  expect(await nats.store.head()).toBe(before + 1);
  const saved = await rows();
  expect(saved.at(-1)?.event).toMatchObject({ type: 'routine.paused',
    principal: { kind: 'human', id: 'admin' }, data: { actorId: 'admin', source: 'admin',
      reason: 'admin_requested', affectedRun: 'occurrence', controlRevision: 2 } });
  let state: RoutineState | undefined;
  for (const row of saved) {
    state = foldRoutine(state, row.event);
  }
  expect(state).toMatchObject({ status: 'paused', executionAvailable: false });
  expect(state?.activeRun).toEqual(occupied.data);
  expect(state?.definition?.definition).toEqual(state?.activeRun?.definition);
  const auth = memberAuthorisation(binding, nats.store);
  expect((await auth.routine('admin', 'orders', 'manage')).allowed).toBe(false);
  expect((await auth.conversation('admin', 'conversation', 'read')).allowed).toBe(false);
}
it('saves one admin pause with the occupied run and no private access or replay effects',
  savesAdminPause);

async function roleChange(memberId = 'admin', type = 'member.role_changed', silo = 'test') {
  const changed: EventEnvelope = { ...event(`changed-${memberId}`, `member-${memberId}`, type), silo,
    data: { memberId, previousRole: 'admin', newRole: 'member', changedBy: 'alice' } };
  if (type === 'member.removed') {
    changed.data = { memberId, removedBy: 'alice' };
  }
  await nats.seed([changed]);
  return changed;
}
async function privateRefusal(kind: string) {
  await occupy();
  await pause();
  let memberId = 'admin';
  if (kind === 'ordinary owner') memberId = 'alice';
  if (kind === 'ordinary member') memberId = 'bob';
  if (kind === 'removed') await roleChange('admin', 'member.removed');
  if (kind === 'demoted') await roleChange();
  if (kind === 'missing role receipt') {
    const changed = await roleChange();
    const promoted = { ...changed, id: 'promoted', commandId: 'promoted',
      data: { memberId: 'admin', previousRole: 'member', newRole: 'admin', changedBy: 'alice' } };
    await nats.seed([promoted]);
  }
  if (kind === 'missing routine receipt') {
    await nats.seed([routine('routine.reassigned', 'alice')]);
  }
  const before = await nats.store.head();
  for (const change of [{}, { expectedPosition: 0 }, { expectedDefinitionRevision: 99 },
    { changeId: 'orders:unknown' }, { changeId: 'other:pause' }]) {
    await expect(pause(memberId, { ...input, ...change }))
      .rejects.toThrow(/^Routine admin pause refused$/u);
  }
  expect(await nats.store.head()).toBe(before);
}
it.each(['ordinary owner', 'ordinary member', 'removed', 'demoted',
  'missing role receipt', 'missing routine receipt'])(
  'refuses %s before disclosing saved receipts or conflicts', privateRefusal);

async function removedBeforeOwnershipFailure() {
  await occupy();
  await roleChange('admin', 'member.removed');
  const before = await nats.store.head();
  const healthyRequest = pause();
  await expect(healthyRequest).rejects.toThrow(/^Routine admin pause refused$/u);
  const healthyRefusal = await healthyRequest.catch(captureError);
  expect(await nats.store.head()).toBe(before);

  const read = nats.store.readStream.bind(nats.store);
  async function* failedOwnership(subject: string, from?: number, deadline?: number) {
    if (subject === 'ownership-test') {
      throw new Error('private ownership history failure');
    }
    yield* read(subject, from, deadline);
  }
  vi.spyOn(nats.store, 'readStream').mockImplementation(failedOwnership);
  const failedRequest = pause();
  await expect(failedRequest).rejects.toThrow(/^Routine admin pause refused$/u);
  expect(await failedRequest.catch(captureError)).toEqual(healthyRefusal);
  expect(await nats.store.head()).toBe(before);
}
function captureError(error: unknown) {
  return error;
}
it('keeps the same refusal and saves nothing after removal when ownership history fails',
  removedBeforeOwnershipFailure);

async function losesReply() {
  await occupy();
  const append = nats.store.append.bind(nats.store);
  async function lost(change: AppendCommand): Promise<never> {
    await append(change);
    throw new Error('private-service-canary');
  }
  vi.spyOn(nats.store, 'append').mockImplementationOnce(lost);
  await expect(pause()).rejects.toThrow(/^Routine admin pause unavailable$/u);
  await waitForDuplicateWindow(nats);
  await nats.stop();
  await nats.restart();
  const before = await nats.store.head();
  const [first, concurrent] = await Promise.all([pause(), pause()]);
  expect(concurrent).toEqual(first);
  expect(first.position).toBe(await nats.store.head('routine-orders'));
  expect(await rows()).toHaveLength(3);
  for (const change of [{ expectedPosition: 0 }, { expectedDefinitionRevision: 2 },
    { expectedScheduleRevision: 2 }, { expectedControlRevision: 2 },
    { changeId: 'orders:another' }, { changeId: 'another:pause' }]) {
    await expect(pause('admin', { ...input, ...change }))
      .rejects.toThrow(/^Routine admin pause conflict$/u);
  }
  expect(await nats.store.head()).toBe(before);
}
it('recovers races and lost replies after duplicate expiry and restart, with exact intent',
  losesReply);

async function writeWindow(kind: string) {
  await occupy();
  const read = nats.store.readStream.bind(nats.store);
  const append = nats.store.append.bind(nats.store);
  const now = performance.now.bind(performance);
  let elapsed = 0;
  let writing = false;
  function clock() {
    return now() + elapsed;
  }
  async function* historyFirst(subject: string, from?: number, deadline?: number) {
    expect(writing).toBe(false);
    yield* read(subject, from, deadline);
    if (subject === 'routine-orders') elapsed += 3000;
  }
  async function publish(change: AppendCommand) {
    writing = true;
    expect(change.deadline! - clock()).toBeLessThanOrEqual(2000);
    if (kind === 'expired') elapsed += 2001;
    if (kind === 'demoted') await roleChange();
    return append(change);
  }
  vi.spyOn(performance, 'now').mockImplementation(clock);
  vi.spyOn(nats.store, 'readStream').mockImplementation(historyFirst);
  vi.spyOn(nats.store, 'append').mockImplementationOnce(publish);
  if (kind === 'slow history') {
    await expect(pause()).resolves.toMatchObject({ status: 'confirmed' });
  } else {
    await expect(pause()).rejects.toThrow();
    vi.restoreAllMocks();
    expect(await rows()).toHaveLength(2);
  }
}
it.each(['slow history', 'expired', 'demoted'])(
  'keeps history outside the two-second write check: %s', writeWindow);

async function savedAuthority(kind: string) {
  await occupy();
  const saved = await pause();
  await roleChange('admin', kind);
  const proof = await readRootStopEvidence(nats.store, 'routine-orders', saved.position);
  expect(proof.routine).toMatchObject({ status: 'paused', executionAvailable: false,
    activeRun: { occurrenceId: 'occurrence' } });
}
it.each(['member.removed', 'member.role_changed'])(
  'validates authority at the saved pause despite later %s', savedAuthority);

async function siloOwnerPause() {
  await occupy();
  const joined = joinedMember('owner');
  const owner = { ...joined, data: { memberId: 'owner', email: 'owner@example.test',
    displayName: 'Owner', role: 'owner' } };
  const seeded = { ...event('ownership-seed-test', 'ownership-test', 'ownership.seeded'),
    data: { ownerIds: ['owner'] } };
  const auth = memberAuthorisation(binding, nats.store);
  await nats.seed([owner, seeded]);
  await auth.handler.handle(owner, db);
  await auth.handler.handle(seeded, db);
  const saved = await pause('owner');
  const proof = await readRootStopEvidence(nats.store, 'routine-orders', saved.position);
  expect(proof.event).toMatchObject({ principal: { kind: 'human', id: 'owner' },
    data: { actorId: 'owner', source: 'admin' } });
  await expect(pause('admin')).rejects.toThrow(/^Routine admin pause conflict$/u);
}
it('permits a current silo owner and binds retries to the actual actor', siloOwnerPause);
