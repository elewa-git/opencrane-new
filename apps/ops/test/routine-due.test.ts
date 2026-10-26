import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { parseEventByType, foldRoutine, getEventDefinition, routineControlSchema,
  type RoutineState } from '@opencrane/events';
import type { EventEnvelope } from '@opencrane/events';
import type { AppendCommand, StoredEvent } from '@opencrane/event-store';
import { createEventStore } from '@opencrane/event-store';
import { shortDuplicateWindowFixture, waitForDuplicateWindow }
  from '../../server/test/support/duplicate-window.ts';
import { HandlerRuntime } from '@opencrane/handlers';
import { SandboxClient } from '../src/kubernetes.ts';
import { routine } from '../../../libs/authz/test/routine-fixture.ts';
import { claimRoutineDue } from '../src/routine-due.ts';

let nats: Awaited<ReturnType<typeof shortDuplicateWindowFixture>>;
let now: number;
let owned: boolean;
const input = { routineId: 'orders', expectedPosition: 1, localDate: '2026-10-25',
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
  await nats.seed([creation()]);
}
async function cleanup() {
  vi.restoreAllMocks();
  await nats?.close();
}
beforeEach(setup);
afterEach(cleanup);
function claim(request = input) {
  return claimRoutineDue(nats.store, worker, request);
}
async function rows() {
  const result: StoredEvent[] = [];
  for await (const row of nats.store.readStream('routine-orders')) {
    result.push(row);
  }
  return result;
}
async function savesOneOccurrence() {
  vi.spyOn(globalThis, 'fetch').mockImplementation(forbiddenEffect);
  vi.spyOn(HandlerRuntime.prototype, 'start').mockImplementation(forbiddenEffect);
  vi.spyOn(SandboxClient.prototype, 'mode').mockImplementation(forbiddenEffect);
  vi.spyOn(SandboxClient.prototype, 'credentials').mockImplementation(forbiddenEffect);
  const [first, second] = await Promise.all([claim(), claim()]);
  expect(second).toEqual(first);
  const expected = { status: 'confirmed', position: 2,
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
  expect(await nats.store.head()).toBe(2);
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
  const request = { ...input, expectedPosition: 4, localDate: next.localDate };
  await claim(request);
  await finish();
  await waitForDuplicateWindow(nats);
  await nats.stop();
  await nats.restart();
  const connection = await nats.client('command');
  const restarted = await createEventStore(connection);
  const before = await nats.store.head();
  expect(await claimRoutineDue(restarted, worker, input)).toEqual(first);
  expect(await rows()).toHaveLength(6);
  expect(await nats.store.head()).toBe(before);
}
it('recovers the original record after lost reply, later completions, expiry and restart',
  recoversOriginal);

async function refusesChangedClaim() {
  await claim();
  const changes = [{ definitionRevision: 2 }, { scheduleRevision: 2 },
    { controlRevision: 2 }, { localDate: '2026-11-01' }, { expectedPosition: 2 },
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
  expect(await nats.store.head()).toBe(1);
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
    const overlapping = { ...input, expectedPosition: 2 };
    await expect(claim(overlapping)).rejects.toThrow();
    expect(await nats.store.head()).toBe(2);
    return;
  }
  event = { ...event, data };
  await nats.seed([event]);
  const localDate = kind === 'gap' ? '2027-03-28' : input.localDate;
  const request = { ...input, expectedPosition: 2, localDate };
  await expect(claim(request)).rejects.toThrow();
  expect(await nats.store.head()).toBe(2);
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
  expect(await nats.store.head()).toBe(2);
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
  expect(await nats.store.head()).toBe(1);
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
    expect(subject).toBe('routine-orders');
    expect(deadline).toBe(started + 10_000);
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
  expect(await nats.store.head()).toBe(2);
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
  expect(await nats.store.head()).toBe(1);
}
it('refuses history that finishes after its own deadline', refusesExpiredHistory);
