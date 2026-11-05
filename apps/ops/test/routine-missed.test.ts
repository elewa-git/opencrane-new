import { HandlerRuntime } from '@opencrane/handlers';
import { SandboxClient } from '../src/kubernetes.ts';
import { calculateRoutineOccurrence } from '@opencrane/events/routine-schedule';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { routineMissedSchema, foldRoutine, type EventEnvelope, type RoutineState } from '@opencrane/events';
import { createStore, memberAuthorisation, type Binding } from '@opencrane/authz';
import { createEventStore, type AppendCommand } from '@opencrane/event-store';
import { event } from '@opencrane/event-store/testing';
import { TupleClient, objectId } from '../../../libs/authz/src/client.ts';
import { openfga } from '../../../libs/authz/test/services.ts';
import { routine, joinedMember } from '../../../libs/authz/test/routine-fixture.ts';
import { shortDuplicateWindowFixture, waitForDuplicateWindow }
  from '../../server/test/support/duplicate-window.ts';
import { routineAsk } from '../../server/test/support/routine-ask.ts';
import { claimRoutineDue } from '../src/routine-due.ts';
import { recordRoutineMissed } from '../src/routine-missed.ts';

let nats: Awaited<ReturnType<typeof shortDuplicateWindowFixture>>;
let fga: Awaited<ReturnType<typeof openfga>>;
let binding: Binding;
let now: number;
let owned: boolean;
let stop: AbortController;
const input = { routineId: 'orders', expectedPosition: 2, localDate: '2027-03-27',
  definitionRevision: 1, scheduleRevision: 1, controlRevision: 1 };
function clock() {
  return now;
}
function checkCurrent() {
  return Promise.resolve(owned);
}
function worker() {
  return { silo: 'test', binding, now: clock, checkCurrent, signal: stop.signal };
}
function creation() {
  const example = foldRoutine(undefined, routine('routine.created')).definition!;
  const schedule = { frequency: 'daily' as const,
    localTime: '02:30', zone: 'Europe/Brussels' };
  const definition = { ...example.definition, schedule };
  const data = { ...example, status: 'active' as const, definition,
    effectiveAt: '2027-03-26T12:00:00.000Z', next: { localDate: '2027-03-27',
      localTime: '02:30', zone: 'Europe/Brussels', at: '2027-03-27T01:30:00.000Z',
      offsetMinutes: 60 } };
  return { ...routine('routine.created'), time: data.effectiveAt, data };
}
async function setup() {
  nats = await shortDuplicateWindowFixture();
  fga = await openfga();
  binding = await createStore(fga.apiUrl, 'test');
  now = Date.parse('2027-03-30T00:31:00.001Z');
  owned = true;
  stop = new AbortController();
  const events = [joinedMember('alice'), creation()];
  await nats.seed(events);
  const auth = memberAuthorisation(binding, nats.store);
  const database = { query: forbiddenEffect };
  for (const saved of events) {
    await auth.handler.handle(saved, database);
  }
}
function forbiddenEffect(): never {
  throw new Error('Forbidden effect');
}
async function cleanup() {
  vi.restoreAllMocks();
  await fga?.close();
  await nats?.close();
}
beforeEach(setup);
afterEach(cleanup);
function record(request = input) {
  return recordRoutineMissed(nats.store, worker(), request);
}
async function state() {
  let saved: RoutineState | undefined;
  for await (const row of nats.store.readStream('routine-orders')) {
    saved = foldRoutine(saved, row.event);
  }
  return saved!;
}
async function range() {
  const wake = vi.spyOn(SandboxClient.prototype, 'mode');
  const credentials = vi.spyOn(SandboxClient.prototype, 'credentials');
  const jobs = vi.spyOn(HandlerRuntime.prototype, 'start');
  wake.mockImplementation(forbiddenEffect);
  credentials.mockImplementation(forbiddenEffect);
  jobs.mockImplementation(forbiddenEffect);
  const fetch = globalThis.fetch;
  function permissionFetch(url: Parameters<typeof fetch>[0], options?: RequestInit) {
    const address = url instanceof Request ? url.url : url.toString();
    if (!address.startsWith(binding.apiUrl + '/')) {
      return forbiddenEffect();
    }
    return fetch(url, options);
  }
  const network = vi.spyOn(globalThis, 'fetch');
  network.mockImplementation(permissionFetch);
  const before = await state();
  const [receipt, repeated] = await Promise.all([record(), record()]);
  expect(repeated).toEqual(receipt);
  expect(receipt.executionAvailable).toBe(false);
  const row = await nats.store.readEvent(receipt.position);
  const expected = { firstLocalDate: '2027-03-27', lastLocalDate: '2027-03-30', count: 3,
    reason: 'downtime', cursor: { localDate: '2027-03-30' },
    next: { localDate: '2027-03-31', at: '2027-03-31T00:30:00.000Z' } };
  expect(row.event.type).toBe('routine.occurrences_missed');
  expect(row.event.data).toMatchObject(expected);
  expect(await state()).toEqual(foldRoutine(before, row.event));
  expect(await nats.store.head()).toBe(3);
  expect(wake).not.toHaveBeenCalled();
  expect(credentials).not.toHaveBeenCalled();
  expect(jobs).not.toHaveBeenCalled();
  expect(JSON.stringify(row.event)).not.toMatch(/ciphertext|instructions|key:1/u);
  const stale = { ...input, expectedPosition: receipt.position };
  await expect(record(stale)).rejects.toThrow();
  await expect(claimRoutineDue(nats.store, worker(), stale)).rejects.toThrow();
}
it('compacts only real old slots across Brussels spring, races and replays without execution', range);

const calendars = [
  ['Europe/Brussels', '02:30', '2026-10-24', '2026-10-26', '2026-10-27', 3],
  ['Australia/Lord_Howe', '02:15', '2026-10-03', '2026-10-05', '2026-10-06', 2],
  ['Pacific/Apia', '00:00', '2011-12-29', '2011-12-31', '2012-01-01', 2],
  ['UTC', '09:00', '2027-03-27', '2027-03-29', '2027-03-30', 3],
] as const;
async function calendar(zone: string, localTime: string, first: string, last: string,
  nextDate: string, count: number) {
  const original = creation();
  const schedule = { frequency: 'daily' as const, localTime, zone };
  const definition = { ...original.data.definition, schedule };
  const calculation = { silo: 'test', routineId: 'orders', scheduleRevision: 1, schedule,
    localDate: first };
  const firstSlot = calculateRoutineOccurrence(calculation);
  const next = { localDate: first, localTime, zone, at: firstSlot.at, offsetMinutes:
    firstSlot.offsetMinutes };
  const effectiveAt = new Date(Date.parse(firstSlot.checkAt) - 1).toISOString();
  const data = { ...original.data, definition, effectiveAt, next };
  const updated = { ...original, id: 'calendar', commandId: 'calendar',
    type: 'routine.updated', time: effectiveAt, data };
  await nats.seed([updated]);
  const candidate = { ...calculation, localDate: nextDate };
  const following = calculateRoutineOccurrence(candidate);
  now = Date.parse(following.checkAt) + 60_000;
  const request = { ...input, expectedPosition: 3, localDate: first };
  const receipt = await record(request);
  const row = await nats.store.readEvent(receipt.position);
  const expected = { firstLocalDate: first, lastLocalDate: last, count,
    cursor: { localDate: last }, next: { localDate: nextDate, at: following.at } };
  expect(row.event.data).toMatchObject(expected);
  const dueInput = { ...input, expectedPosition: receipt.position, localDate: nextDate };
  await expect(record(dueInput)).rejects.toThrow();
  await claimRoutineDue(nats.store, worker(), dueInput);
}
it.each(calendars)('counts %s calendar slots and leaves exactly 60 seconds eligible', calendar);

async function gapOnly(lateness: number) {
  const original = creation();
  const effectiveAt = '2027-03-27T12:00:00.000Z';
  const data = { ...original.data, effectiveAt, cursor: null, next: null };
  const updated = { ...original, id: 'gap-only', commandId: 'gap-only',
    type: 'routine.updated', time: effectiveAt, data };
  await nats.seed([updated]);
  now = Date.parse('2027-03-29T00:30:00.000Z') + lateness;
  const request = { ...input, expectedPosition: 3, localDate: '2027-03-28' };
  const before = await state();
  const [receipt, repeated] = await Promise.all([record(request), record(request)]);
  expect(repeated).toEqual(receipt);
  expect(receipt.executionAvailable).toBe(false);
  const row = await nats.store.readEvent(receipt.position);
  const next = { localDate: '2027-03-29', localTime: '02:30', zone: 'Europe/Brussels',
    at: '2027-03-29T00:30:00.000Z', offsetMinutes: 120 };
  const expected = { localDate: '2027-03-28', localTime: '02:30', zone: 'Europe/Brussels',
    reason: 'dst', cursor: null, next };
  expect(row.event.type).toBe('routine.occurrence_skipped');
  expect(row.event.data).toMatchObject(expected);
  expect(row.event.data).not.toHaveProperty('count');
  expect(await nats.store.head()).toBe(4);
  const after = await state();
  expect(after).toEqual(foldRoutine(before, row.event));
  expect(after.activeRun).toBeNull();
  expect(after.executionAvailable).toBe(false);
  expect(after.definition?.next).toEqual(next);
  const stale = { ...request, expectedPosition: receipt.position };
  await expect(record(stale)).rejects.toThrow(/^Routine missed refused$/u);
  const dueInput = { ...stale, localDate: '2027-03-29' };
  await expect(record(dueInput)).rejects.toThrow(/^Routine missed refused$/u);
  await claimRoutineDue(nats.store, worker(), dueInput);
  expect((await state()).activeRun?.slot).toEqual(next);
  expect(await record(request)).toEqual(receipt);
  expect(await nats.store.head()).toBe(5);
}
it.each([0, 60_000])('recovers a Brussels gap once and preserves the next slot at %i ms', gapOnly);

async function bounded() {
  now = Date.parse('2028-01-01T12:00:00Z');
  const first = await record();
  const row = await nats.store.readEvent(first.position);
  const firstData = routineMissedSchema.parse(row.event.data);
  expect(firstData.count).toBe(99);
  const request = { ...input, expectedPosition: first.position,
    localDate: firstData.next!.localDate };
  const second = await record(request);
  const nextRow = await nats.store.readEvent(second.position);
  const secondData = routineMissedSchema.parse(nextRow.event.data);
  expect(secondData.count).toBe(100);
  expect(secondData.firstLocalDate > firstData.lastLocalDate).toBe(true);
  expect(await record()).toEqual(first);
  expect(await record(request)).toEqual(second);
}
it('bounds each scan to 100 candidates and resumes without counting a slot twice', bounded);
async function occupied(kind = 'starting') {
  const updated = creation();
  now = Date.parse(updated.data.next.at);
  const claimed = await claimRoutineDue(nats.store, worker(), input);
  const run = (await state()).activeRun!;
  if (kind !== 'starting') {
    const activation = { ...run, senderAttemptId: 'attempt',
      admission: { eventId: 'admitted', position: claimed.position } };
    const { definition: _definition, source: _source, slot: _slot,
      firedAt: _firedAt, startBy: _startBy, ...binding } = activation;
    const admitted = { ...updated, id: 'activation', commandId: 'activation',
      type: 'routine.run_activation_admitted',
      principal: { kind: 'system' as const, id: 'opencrane-server' },
      data: binding };
    await nats.seed([admitted]);
    if (kind === 'stopping') {
      const data = { ...binding, actorId: 'alice', source: 'owner', reason: 'owner_requested',
        affectedRun: run.occurrenceId, next: null };
      const { senderAttemptId: _sender, admission: _admission, ...control } = data;
      const stopping = { ...updated, id: 'stop', commandId: 'stop',
        type: 'routine.run_stop_requested', data: control };
      await nats.seed([stopping]);
    }
  }
  if (kind === 'Ask') {
    const binding = { conversationId: run.conversationId, turnId: run.turnId };
    await routineAsk(nats.store, 'Requested', binding);
  }
  now = Date.parse('2027-03-30T00:31:00.001Z');
  return { ...input, expectedPosition: await nats.store.head('routine-orders') };
}
async function overlap(kind: string) {
  const request = await occupied(kind);
  const before = await state();
  const [receipt, repeated] = await Promise.all([record(request), record(request)]);
  expect(repeated).toEqual(receipt);
  const row = await nats.store.readEvent(receipt.position);
  const range = { count: 2, firstLocalDate: '2027-03-29', lastLocalDate: '2027-03-30' };
  expect(row.event.data).toMatchObject(range);
  const after = await state();
  expect(after.activeRun).toEqual(before.activeRun);
  expect(after.activation).toEqual(before.activation);
  expect(after.stopRequested).toBe(before.stopRequested);
  expect(after.definition?.cursor?.at).toBe('2027-03-30T00:30:00.000Z');
  expect(after.definition?.next?.at).toBe('2027-03-31T00:30:00.000Z');
  expect(await record(request)).toEqual(receipt);
}
it.each(['starting', 'running', 'Ask', 'stopping'])('preserves an occupied %s run', overlap);
async function recovery() {
  const append = nats.store.append.bind(nats.store);
  async function loseReply(change: AppendCommand): Promise<never> {
    await append(change);
    throw new Error('private-service-canary');
  }
  const spy = vi.spyOn(nats.store, 'append');
  spy.mockImplementationOnce(loseReply);
  await expect(record()).rejects.toThrow(/^Routine missed unavailable$/u);
  const first = await record();
  await waitForDuplicateWindow(nats);
  await nats.stop();
  await nats.restart();
  const connection = await nats.client('command');
  const restarted = await createEventStore(connection);
  now += 86_400_000;
  expect(await recordRoutineMissed(restarted, worker(), input)).toEqual(first);
  const changes = [
    { definitionRevision: 2 },
    { scheduleRevision: 2 },
    { controlRevision: 2 },
    { localDate: '2027-04-04' },
    { expectedPosition: first.position },
    { firstLocalDate: '2027-03-29' },
    { lastLocalDate: '2027-03-31' },
    { count: 99 },
  ];
  for (const change of changes) {
    const request = { ...input, ...change };
    await expect(recordRoutineMissed(restarted, worker(), request)).rejects.toThrow();
  }
}
it('recovers the same receipt after lost reply, restart and dedupe expiry', recovery);
async function access(kind: string, phase: string) {
  async function revoke() {
    if (kind === 'worker') {
      owned = false;
    } else if (kind === 'signal') {
      stop.abort();
    } else if (kind === 'member') {
      await nats.seed([event('removed', 'member-alice', 'member.removed')]);
    } else {
      const client = new TupleClient(binding);
      const receipt = { user: objectId('silo', 'test'), relation: 'applied',
        object: objectId('projection_event', 'test', creation().id) };
      await client.write([], [receipt]);
    }
  }
  if (phase === 'retry') {
    await record();
  }
  const before = await nats.store.head();
  if (phase === 'after') {
    const append = nats.store.append.bind(nats.store);
    async function revokeAfterAppend(change: AppendCommand) {
      const result = await append(change);
      await revoke();
      return result;
    }
    const spy = vi.spyOn(nats.store, 'append');
    spy.mockImplementationOnce(revokeAfterAppend);
  } else {
    await revoke();
  }
  await expect(record()).rejects.toThrow(/^Routine missed refused$/u);
  const saved = await state();
  expect(saved.definition?.cursor !== null).toBe(phase !== 'before');
  if (phase === 'after') {
    expect(await nats.store.head('routine-orders')).toBe(before + 1);
  }
}
const ownerRemoval = access.bind(null, 'member');
const lostLeadership = access.bind(null, 'worker');
const cancellationAccess = access.bind(null, 'signal');
const missingReceipts = access.bind(null, 'receipt');
it.each(['before', 'retry', 'after'])('refuses owner removal %s', ownerRemoval);
it.each(['before', 'retry', 'after'])('refuses lost leadership %s', lostLeadership);
it.each(['before', 'retry', 'after'])('refuses cancellation %s', cancellationAccess);
it.each(['before', 'retry', 'after'])('refuses missing receipts %s', missingReceipts);
async function refused(kind: string) {
  if (kind === 'history') {
    const read = vi.spyOn(nats.store, 'readStream');
    read.mockImplementation(forbiddenEffect);
  } else {
    const original = creation();
    let changed: EventEnvelope = { ...original, id: 'changed', commandId: 'changed',
      type: 'routine.updated', data: { ...original.data, status: 'paused' } };
    if (kind === 'edit') {
      changed.data = { ...original.data, definitionRevision: 2 };
    } else if (kind === 'weekly') {
      const schedule = { frequency: 'weekly', weekday: 6, localTime: '02:30',
        zone: 'Europe/Brussels' };
      const definition = { ...original.data.definition, schedule };
      changed.data = { ...original.data, definition };
    } else if (kind === 'retire') {
      changed = routine('routine.retired');
    }
    await nats.seed([changed]);
  }
  const request = { ...input, expectedPosition: await nats.store.head('routine-orders') };
  await expect(record(request)).rejects.toThrow(/^Routine missed refused$/u);
}
it.each(['pause', 'edit', 'retire', 'history', 'weekly'])('refuses %s safely', refused);
async function cancellation(afterAccess: boolean) {
  const append = nats.store.append.bind(nats.store);
  const head = nats.store.head.bind(nats.store);
  let appending = false;
  async function readHead(...args: Parameters<typeof head>) {
    if (appending && !afterAccess && args[0] === 'member-alice') {
      stop.abort();
    }
    return head(...args);
  }
  async function observedAppend(change: AppendCommand) {
    appending = true;
    async function checkAccess() {
      await change.checkAccess!();
      if (afterAccess) {
        stop.abort();
      }
    }
    const checked = { ...change, checkAccess };
    return append(checked);
  }
  const read = vi.spyOn(nats.store, 'head');
  read.mockImplementation(readHead);
  const write = vi.spyOn(nats.store, 'append');
  write.mockImplementationOnce(observedAppend);
  await expect(record()).rejects.toThrow(/^Routine missed refused$/u);
  expect(await nats.store.head()).toBe(2);
}
it.each([false, true])('saves nothing on lease cancellation, after access %s', cancellation);
