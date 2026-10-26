import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { parseEventByType, foldRoutine, getEventDefinition, routineControlSchema,
  type RoutineState } from '@opencrane/events';
import type { EventEnvelope } from '@opencrane/events';
import type { AppendCommand, StoredEvent } from '@opencrane/event-store';
import { event } from '@opencrane/event-store/testing';
import { createStore, memberAuthorisation, type Binding } from '@opencrane/authz';
import { TupleClient, objectId } from '../../../libs/authz/src/client.ts';
import { openfga } from '../../../libs/authz/test/services.ts';
import { createEventStore } from '@opencrane/event-store';
import { shortDuplicateWindowFixture, waitForDuplicateWindow }
  from '../../server/test/support/duplicate-window.ts';
import { HandlerRuntime } from '@opencrane/handlers';
import { SandboxClient } from '../src/kubernetes.ts';
import { routine, joinedMember } from '../../../libs/authz/test/routine-fixture.ts';
import { claimRoutineDue } from '../src/routine-due.ts';

let nats: Awaited<ReturnType<typeof shortDuplicateWindowFixture>>;
let fga: Awaited<ReturnType<typeof openfga>>;
let binding: Binding;
let now: number;
let owned: boolean;
const input = { routineId: 'orders', expectedPosition: 2, localDate: '2026-10-25',
  definitionRevision: 1, scheduleRevision: 1, controlRevision: 1 };
function clock() {
  return now;
}
function checkCurrent() {
  return Promise.resolve(owned);
}
const worker = { silo: 'test', checkCurrent, now: clock };
function creation() {
  const example = foldRoutine(undefined, routine('routine.created')).definition!;
  const schedule = { frequency: 'weekly' as const, weekday: 7,
    localTime: '02:30', zone: 'Europe/Brussels' };
  const definition = { ...example.definition, schedule };
  const next = { localDate: input.localDate, localTime: '02:30', zone: 'Europe/Brussels',
    at: '2026-10-25T00:30:00.000Z', offsetMinutes: 120 };
  const data = { ...example, status: 'active', definition, next };
  return { id: 'created', commandId: 'created', silo: 'test', source: 'opencrane-server',
    type: 'routine.created', subject: 'routine-orders', time: example.effectiveAt,
    principal: { kind: 'human', id: 'alice' }, correlation: {}, data } satisfies EventEnvelope;
}
async function setup() {
  nats = await shortDuplicateWindowFixture();
  now = Date.parse('2026-10-25T00:30:00.000Z');
  owned = true;
  fga = await openfga();
  binding = await createStore(fga.apiUrl, 'test');
  const joined = joinedMember('alice');
  const created = creation();
  await nats.seed([joined, created]);
  const auth = memberAuthorisation(binding, nats.store);
  const db = { query: forbiddenEffect };
  await auth.handler.handle(joined, db);
  await auth.handler.handle(created, db);
}
async function cleanup() {
  vi.restoreAllMocks();
  await fga?.close();
  await nats?.close();
}
beforeEach(setup, 30_000);
afterEach(cleanup);
function claim(request = input) {
  return claimRoutineDue(nats.store, { ...worker, binding }, request);
}
async function rows() {
  const result: StoredEvent[] = [];
  for await (const row of nats.store.readStream('routine-orders')) {
    result.push(row);
  }
  return result;
}
async function savesOneOccurrence() {
  const fetch = globalThis.fetch;
  function permissionFetch(url: Parameters<typeof fetch>[0], options?: RequestInit) {
    const address = url instanceof Request ? url.url : url.toString();
    if (!address.startsWith(binding.apiUrl + '/')) {
      return forbiddenEffect();
    }
    return fetch(url, options);
  }
  vi.spyOn(globalThis, 'fetch').mockImplementation(permissionFetch);
  vi.spyOn(HandlerRuntime.prototype, 'start').mockImplementation(forbiddenEffect);
  vi.spyOn(SandboxClient.prototype, 'mode').mockImplementation(forbiddenEffect);
  vi.spyOn(SandboxClient.prototype, 'credentials').mockImplementation(forbiddenEffect);
  const [first, second] = await Promise.all([claim(), claim()]);
  expect(second).toEqual(first);
  const expected = { status: 'confirmed', position: 3,
    firedAt: '2026-10-25T00:30:00.000Z', startBy: '2026-10-25T00:31:00.000Z',
    executionAvailable: false };
  expect(first).toMatchObject(expected);
  expect(new Set([first.occurrenceId, first.conversationId, first.messageId,
    first.turnId, first.rootId]).size).toBe(5);
  const saved = await rows();
  expect(saved).toHaveLength(2);
  const state = savedState(saved);
  expect(state?.executionAvailable).toBe(false);
  expect(state?.activeRun?.definition).toEqual(state?.definition?.definition);
  expect(state?.activeRun?.slot.at).toBe('2026-10-25T00:30:00.000Z');
  expect(await nats.store.head()).toBe(3);
  expect(JSON.stringify(first)).not.toMatch(/ciphertext|instructions|key:1/u);
}
it('claims the first repeated-hour instant once without starting any work', savesOneOccurrence);

function forbiddenEffect(): never {
  throw new Error('Forbidden routine effect');
}
function savedState(saved: StoredEvent[]) {
  let state: RoutineState | undefined;
  for (const row of saved) {
    state = foldRoutine(state, row.event);
  }
  return state;
}
async function finish() {
  const saved = await rows();
  const row = saved.at(-1)!;
  const run = savedState(saved)!.activeRun!;
  const data = { version: 1, routineId: 'orders', definitionRevision: run.definitionRevision,
    scheduleRevision: run.scheduleRevision, controlRevision: run.controlRevision,
    occurrenceId: run.occurrenceId, rootId: run.rootId, conversationId: run.conversationId,
    messageId: run.messageId, turnId: run.turnId, outcome: 'succeeded', reason: 'root_finished',
    terminalEvidence: { eventId: 'closed', position: 1 } };
  const event = { ...row.event, id: `finished-${run.occurrenceId}`,
    commandId: `finished-${run.occurrenceId}`, type: 'routine.run_finished', data };
  await nats.seed([event]);
  return event;
}
async function recoversOriginal() {
  const append = nats.store.append.bind(nats.store);
  async function loseReply(change: AppendCommand): Promise<never> {
    await append(change);
    throw new Error('private-service-canary');
  }
  vi.spyOn(nats.store, 'append').mockImplementationOnce(loseReply);
  await expect(claim()).rejects.toThrow('Routine due unavailable');
  const first = await claim();
  await finish();
  const created = creation();
  const saved = created.data;
  const next = { ...saved.next, localDate: '2026-11-01',
    at: '2026-11-01T01:30:00.000Z', offsetMinutes: 60 };
  const data = { ...saved, next };
  const updated = { ...created, id: 'updated', commandId: 'updated',
    type: 'routine.updated', data };
  await nats.seed([updated]);
  now = Date.parse(next.at);
  const request = { ...input, expectedPosition: 5, localDate: next.localDate };
  await claim(request);
  await finish();
  await waitForDuplicateWindow(nats);
  await nats.stop();
  await nats.restart();
  const connection = await nats.client('command');
  const restarted = await createEventStore(connection);
  const before = await nats.store.head();
  expect(await claimRoutineDue(restarted, { ...worker, binding }, input)).toEqual(first);
  expect(await rows()).toHaveLength(6);
  expect(await nats.store.head()).toBe(before);
}
it('recovers the original record after lost reply, later completions, expiry and restart',
  recoversOriginal);

async function refusesChangedClaim() {
  await claim();
  const changes = [{ definitionRevision: 2 }, { scheduleRevision: 2 },
    { controlRevision: 2 }, { localDate: '2026-11-01' }, { expectedPosition: 3 },
    { definition: {} }, { ownerId: 'bob' }, { firedAt: '2026-10-25T00:30:10Z' }];
  for (const change of changes) {
    const request = { ...input, ...change };
    await expect(claim(request)).rejects.toThrow();
  }
  await finish();
  await waitForDuplicateWindow(nats);
  const expectedPosition = await nats.store.head('routine-orders');
  const repeated = { ...input, expectedPosition };
  await expect(claim(repeated)).rejects.toThrow();
  expect(await rows()).toHaveLength(3);
}
it('refuses changed claims and cannot reclaim a completed slot after dedupe expiry',
  refusesChangedClaim);

async function refusesTiming(offset: number) {
  now += offset;
  await expect(claim()).rejects.toThrow('Routine due refused');
  expect(await nats.store.head()).toBe(2);
}
it.each([-1, 60_001, 3_600_000])('refuses a slot at offset %i milliseconds', refusesTiming);
async function allowsLastMillisecond() {
  now += 60_000;
  const first = await claim();
  now += 3_600_000;
  expect(await claim()).toEqual(first);
  expect(first.startBy).toBe('2026-10-25T00:32:00.000Z');
}
it('accepts exactly sixty seconds of lateness and never extends startBy', allowsLastMillisecond);

async function refusesHistory(kind: string) {
  const original = creation();
  const definition = original.data;
  let data: unknown = { ...definition, status: 'paused' };
  let event = { ...original, id: kind, commandId: kind, type: 'routine.updated', data };
  if (kind === 'legacy') {
    data = { routineId: 'orders', schedule: '* * * * *', updatedBy: 'alice' };
  } else if (kind === 'malformed') {
    data = { routineId: 'orders', version: 1 };
  } else if (kind === 'foreign') {
    event.silo = 'another-silo';
  } else if (kind === 'gap') {
    const next = { ...definition.next, localDate: '2027-03-28',
      at: '2027-03-28T01:30:00.000Z', offsetMinutes: 60 };
    data = { ...definition, next };
    now = Date.parse(next.at);
  } else if (kind === 'overlap') {
    await claim();
    const overlapping = { ...input, expectedPosition: 3 };
    await expect(claim(overlapping)).rejects.toThrow();
    expect(await nats.store.head()).toBe(3);
    return;
  }
  event = { ...event, data };
  await nats.seed([event]);
  const localDate = kind === 'gap' ? '2027-03-28' : input.localDate;
  const request = { ...input, expectedPosition: 3, localDate };
  await expect(claim(request)).rejects.toThrow();
  expect(await nats.store.head()).toBe(3);
}
it.each(['paused', 'legacy', 'malformed', 'foreign', 'gap', 'overlap'])(
  'refuses %s history without dispatch', refusesHistory);

async function racesControl(type: string) {
  const append = nats.store.append.bind(nats.store);
  async function changeBeforeAppend(change: AppendCommand) {
    const example = routineControlSchema.parse(getEventDefinition('routine.paused')!.example);
    let data: object = { ...example, controlRevision: 2 };
    if (type === 'routine.reassigned') {
      const saved = creation().data;
      data = { ...data, source: 'admin', definition: { ...saved.definition, ownerId: 'bob' } };
    }
    const event = { ...creation(), id: type, commandId: type, type, data };
    await nats.seed([event]);
    return append(change);
  }
  vi.spyOn(nats.store, 'append').mockImplementationOnce(changeBeforeAppend);
  await expect(claim()).rejects.toThrow();
  expect(await nats.store.head()).toBe(3);
  const saved = await rows();
  expect(saved[1]?.event.type).toBe(type);
}
it.each(['routine.paused', 'routine.retired', 'routine.reassigned'])(
  'refuses a queued %s race', racesControl);

async function checksOwnershipAndDeadline(kind: string) {
  const append = nats.store.append.bind(nats.store);
  const started = performance.now();
  const clock = vi.spyOn(performance, 'now').mockReturnValue(started);
  async function invalidate(change: AppendCommand) {
    expect(change.deadline).toBe(started + 2000);
    expect(change.historyChecked).toBe(true);
    if (kind === 'ownership') {
      owned = false;
    } else if (kind === 'late') {
      now += 60_001;
    } else {
      clock.mockReturnValue(started + 2001);
    }
    return append(change);
  }
  vi.spyOn(nats.store, 'append').mockImplementationOnce(invalidate);
  await expect(claim()).rejects.toThrow();
  vi.restoreAllMocks();
  expect(await nats.store.head()).toBe(2);
}
it.each(['ownership', 'late', 'deadline'])(
  'refuses expired %s inside the append', checksOwnershipAndDeadline);

async function retainsHistory() {
  const read = nats.store.readStream.bind(nats.store);
  const append = nats.store.append.bind(nats.store);
  const started = performance.now();
  const clock = vi.spyOn(performance, 'now').mockReturnValue(started);
  let appending = false;
  async function* slowRead(subject: string, from?: number, deadline?: number) {
    expect(appending).toBe(false);
    expect(['routine-orders', 'member-alice', 'ownership-test']).toContain(subject);
    expect(deadline).toBeGreaterThanOrEqual(started + 10_000);
    yield* read(subject, from, deadline);
    clock.mockReturnValue(started + 3000);
  }
  async function checkedAppend(change: AppendCommand) {
    appending = true;
    expect(change.deadline).toBe(started + 5000);
    return append(change);
  }
  vi.spyOn(nats.store, 'readStream').mockImplementation(slowRead);
  vi.spyOn(nats.store, 'append').mockImplementationOnce(checkedAppend);
  await claim();
}
it('retains slow history before the short check without reading conversations', retainsHistory);

async function refusesChangedRecord(field: string) {
  const append = nats.store.append.bind(nats.store);
  async function changeRecord(change: AppendCommand) {
    const checked = parseEventByType(change.event);
    if (!checked.success) {
      throw new Error('Invalid fixture event');
    }
    const event = checked.event;
    const state = foldRoutine(undefined, creation());
    const run = foldRoutine(state, event).activeRun!;
    const data = { ...run, [field]: 'changed-private-canary' };
    const replacement = { ...event, data };
    await nats.seed([replacement]);
    return append(change);
  }
  vi.spyOn(nats.store, 'append').mockImplementationOnce(changeRecord);
  await expect(claim()).rejects.toThrow(/^Routine due (refused|unavailable)$/u);
  await expect(claim()).rejects.toThrow(/^Routine due (refused|unavailable)$/u);
  expect(await nats.store.head()).toBe(3);
}
it.each(['messageId', 'startBy', 'definitionRevision'])(
  'refuses a saved record with changed %s', refusesChangedRecord);

async function refusesExpiredHistory() {
  const read = nats.store.readStream.bind(nats.store);
  const started = performance.now();
  const clock = vi.spyOn(performance, 'now').mockReturnValue(started);
  async function* expiredRead(subject: string, from?: number, deadline?: number) {
    yield* read(subject, from, deadline);
    clock.mockReturnValue(started + 10_001);
  }
  vi.spyOn(nats.store, 'readStream').mockImplementationOnce(expiredRead);
  await expect(claim()).rejects.toThrow();
  vi.restoreAllMocks();
  expect(await nats.store.head()).toBe(2);
}
it('refuses history that finishes after its own deadline', refusesExpiredHistory);

async function refusesLostAccess(kind: string, retry: boolean) {
  if (retry) {
    await claim();
  }
  if (kind === 'removed') {
    await nats.seed([event('removed', 'member-alice', 'member.removed')]);
  } else if (kind === 'missing member') {
    const read = nats.store.readStream.bind(nats.store);
    async function* missingMember(subject: string, from?: number, deadline?: number) {
      if (subject !== 'member-alice') {
        yield* read(subject, from, deadline);
      }
    }
    vi.spyOn(nats.store, 'readStream').mockImplementation(missingMember);
  } else if (kind === 'permission') {
    const client = new TupleClient(binding);
    const owner = { user: objectId('person', 'test', 'alice'), relation: 'owner',
      object: objectId('routine', 'test', 'orders') };
    await client.write([], [owner]);
  } else {
    owned = false;
  }
  const before = await nats.store.head();
  await expect(claim()).rejects.toThrow(/^Routine due refused$/u);
  expect(await nats.store.head()).toBe(before);
}
const accessCases = [
  ['removed', false], ['removed', true], ['missing member', false], ['missing member', true],
  ['permission', false], ['permission', true], ['worker', true],
] as const;
it.each(accessCases)('refuses %s access with retry %s without identifiers', refusesLostAccess);

async function refusesRemovalRace() {
  const append = nats.store.append.bind(nats.store);
  async function removeBeforeAppend(change: AppendCommand) {
    await nats.seed([event('removed', 'member-alice', 'member.removed')]);
    return append(change);
  }
  vi.spyOn(nats.store, 'append').mockImplementationOnce(removeBeforeAppend);
  await expect(claim()).rejects.toThrow(/^Routine due refused$/u);
  expect(await rows()).toHaveLength(1);
}
it('refuses owner removal between the access read and append', refusesRemovalRace);

async function refusesBrokenHistoryWithoutAccess(kind: string) {
  if (kind === 'worker') {
    owned = false;
  } else {
    await nats.seed([event('removed', 'member-alice', 'member.removed')]);
  }
  const read = nats.store.readStream.bind(nats.store);
  async function* brokenHistory(subject: string, from?: number, deadline?: number) {
    if (subject === 'routine-orders') {
      throw new Error('private-service-canary');
    }
    yield* read(subject, from, deadline);
  }
  vi.spyOn(nats.store, 'readStream').mockImplementation(brokenHistory);
  await expect(claim()).rejects.toThrow(/^Routine due refused$/u);
}
it.each(['worker', 'removed'])(
  'keeps broken history indistinguishable with revoked %s access', refusesBrokenHistoryWithoutAccess);

async function twoCompletedOccurrences() {
  const first = await claim();
  const firstFinish = await finish();
  const created = creation();
  const next = { ...created.data.next, localDate: '2026-11-01',
    at: '2026-11-01T01:30:00.000Z', offsetMinutes: 60 };
  const data = { ...created.data, next };
  await nats.seed([{ ...created, id: 'next', commandId: 'next', type: 'routine.updated', data }]);
  now = Date.parse(next.at);
  const request = { ...input, expectedPosition: 5, localDate: next.localDate };
  const second = await claim(request);
  await finish();
  return { first, second, request, firstFinish };
}
async function repeatsOlderCompletion(kind: string) {
  const { first, second, request, firstFinish } = await twoCompletedOccurrences();
  const data = { ...firstFinish.data, outcome: 'failed', reason: 'root_failed' };
  const repeated = { ...firstFinish, id: 'late-finish', commandId: 'late-finish', data };
  await nats.seed([repeated]);
  if (kind === 'recovery') {
    const before = await nats.store.head();
    expect(await claim()).toEqual(first);
    expect(await claim(request)).toEqual(second);
    expect(await nats.store.head()).toBe(before);
    return;
  }
  const created = creation();
  const next = { ...created.data.next, localDate: '2026-11-08',
    at: '2026-11-08T01:30:00.000Z', offsetMinutes: 60 };
  const updated = { ...created, id: 'third', commandId: 'third', type: 'routine.updated',
    data: { ...created.data, next } };
  await nats.seed([updated]);
  now = Date.parse(next.at);
  const thirdRequest = { ...input, expectedPosition: 9, localDate: next.localDate };
  const third = await claim(thirdRequest);
  expect(third.status).toBe('confirmed');
  expect(third.executionAvailable).toBe(false);
  expect(third.occurrenceId).not.toBe(first.occurrenceId);
  expect(third.occurrenceId).not.toBe(second.occurrenceId);
  expect(await claim(thirdRequest)).toEqual(third);
  expect(await rows()).toHaveLength(9);
}
it.each(['recovery', 'later claim'])(
  'accepts a correctly bound late older completion for %s', repeatsOlderCompletion);

async function refusesChangedOlderCompletion(field: string) {
  const { firstFinish } = await twoCompletedOccurrences();
  let value: string | number = 'changed-private-canary';
  if (field.endsWith('Revision')) {
    value = 99;
  }
  const data = { ...firstFinish.data, [field]: value };
  await nats.seed([{ ...firstFinish, id: 'bad-finish', commandId: 'bad-finish', data }]);
  const before = await nats.store.head();
  await expect(claim()).rejects.toThrow(/^Routine due (refused|unavailable)$/u);
  expect(await nats.store.head()).toBe(before);
}
it.each(['conversationId', 'messageId', 'turnId', 'rootId', 'definitionRevision',
  'scheduleRevision', 'controlRevision'])(
  'refuses a repeated older completion with changed %s', refusesChangedOlderCompletion);

async function refusesAccessLostBeforeReceipt(kind: string) {
  const append = nats.store.append.bind(nats.store);
  async function revokeAfterAppend(change: AppendCommand) {
    const result = await append(change);
    expect(result.status).toBe('appended');
    if (kind === 'member') {
      await nats.seed([event('removed', 'member-alice', 'member.removed')]);
    } else if (kind === 'permission') {
      const client = new TupleClient(binding);
      const owner = { user: objectId('person', 'test', 'alice'), relation: 'owner',
        object: objectId('routine', 'test', 'orders') };
      await client.write([], [owner]);
    } else {
      owned = false;
    }
    return result;
  }
  vi.spyOn(nats.store, 'append').mockImplementationOnce(revokeAfterAppend);
  await expect(claim()).rejects.toThrow(/^Routine due refused$/u);
  expect(await rows()).toHaveLength(2);
  await expect(claim()).rejects.toThrow(/^Routine due refused$/u);
}
it.each(['member', 'permission', 'worker'])(
  'withholds a saved receipt after losing %s access', refusesAccessLostBeforeReceipt);
