import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createStore, memberAuthorisation, type Binding } from '@opencrane/authz';
import { createEventStore } from '@opencrane/event-store';
import { event } from '@opencrane/event-store/testing';
import { foldRoutine, routineMissedSchema, type RoutineState } from '@opencrane/events';
import { calculateRoutineOccurrence } from '@opencrane/events/routine-schedule';
import { openfga } from '../../../libs/authz/test/services.ts';
import { routine, joinedMember } from '../../../libs/authz/test/routine-fixture.ts';
import { shortDuplicateWindowFixture, waitForDuplicateWindow }
  from '../../server/test/support/duplicate-window.ts';
import { claimRoutineDue } from '../src/routine-due.ts';
import { recordRoutineMissed } from '../src/routine-missed.ts';

let nats: Awaited<ReturnType<typeof shortDuplicateWindowFixture>>;
let fga: Awaited<ReturnType<typeof openfga>>;
let binding: Binding;
let now: number;
let stop: AbortController;
let owned: boolean;
const input = { routineId: 'orders', expectedPosition: 2, localDate: '2027-03-21',
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
function forbiddenEffect(): never {
  throw new Error('Forbidden effect');
}
async function setup() {
  nats = await shortDuplicateWindowFixture();
  fga = await openfga();
  binding = await createStore(fga.apiUrl, 'test');
  stop = new AbortController();
  owned = true;
}
async function cleanup() {
  vi.restoreAllMocks();
  await fga?.close();
  await nats?.close();
}
beforeEach(setup);
afterEach(cleanup);
function creation(localDate = input.localDate, zone = 'Europe/Brussels',
  localTime = '02:30', weekday = 7) {
  const original = routine('routine.created');
  const saved = foldRoutine(undefined, original).definition!;
  const schedule = { frequency: 'weekly' as const, weekday, localTime, zone };
  const calculation = { silo: 'test', routineId: 'orders', scheduleRevision: 1,
    schedule, localDate };
  const occurrence = calculateRoutineOccurrence(calculation);
  const effectiveAt = new Date(Date.parse(occurrence.checkAt) - 1).toISOString();
  let next = null;
  if (occurrence.status === 'scheduled') {
    next = { localDate, localTime, zone, at: occurrence.at,
      offsetMinutes: occurrence.offsetMinutes };
  }
  const definition = { ...saved.definition, schedule };
  const data = { ...saved, status: 'active' as const, definition, effectiveAt, next };
  return { ...original, time: effectiveAt, data };
}
async function save(created = creation()) {
  const events = [joinedMember('alice'), created];
  await nats.seed(events);
  const auth = memberAuthorisation(binding, nats.store);
  const database = { query: forbiddenEffect };
  for (const saved of events) {
    await auth.handler.handle(saved, database);
  }
}
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
async function spring() {
  await save();
  now = Date.parse('2027-04-04T00:31:00.000Z');
  const before = await state();
  const [receipt, repeated] = await Promise.all([record(), record()]);
  expect(repeated).toEqual(receipt);
  const row = await nats.store.readEvent(receipt.position);
  expect(row.event.type).toBe('routine.occurrences_missed');
  const next = { localDate: '2027-04-04', localTime: '02:30', zone: 'Europe/Brussels',
    at: '2027-04-04T00:30:00.000Z', offsetMinutes: 120 };
  const expected = { version: 1, routineId: 'orders', definitionRevision: 1,
    scheduleRevision: 1, controlRevision: 1, reason: 'downtime', count: 1,
    firstLocalDate: '2027-03-21', lastLocalDate: '2027-03-21',
    cursor: { localDate: '2027-03-21', localTime: '02:30', zone: 'Europe/Brussels',
      at: '2027-03-21T01:30:00.000Z', offsetMinutes: 60 }, next };
  expect(row.event.data).toEqual(expected);
  const expectedReceipt = { status: 'confirmed', eventId: row.event.id,
    position: 3, executionAvailable: false };
  expect(receipt).toEqual(expectedReceipt);
  expect(await state()).toEqual(foldRoutine(before, row.event));
  expect((await state()).activeRun).toBeNull();
  const request = { ...input, expectedPosition: receipt.position, localDate: '2027-04-04' };
  await expect(record(request)).rejects.toThrow(/^Routine missed refused$/u);
  now += 1;
  const later = await record(request);
  const laterRow = await nats.store.readEvent(later.position);
  const laterRange = { count: 1, firstLocalDate: '2027-04-04',
    lastLocalDate: '2027-04-04', next: { localDate: '2027-04-11' } };
  expect(laterRow.event.data).toMatchObject(laterRange);
  expect(await record()).toEqual(receipt);
  expect(await nats.store.head()).toBe(4);
}
it('excludes the missing Sunday and preserves the next until sixty seconds plus one ms', spring);

const calendars = [
  ['Europe/Brussels', '02:30', 7, '2026-10-18', '2026-10-25', '2026-10-25T00:30:00.000Z',
    120, '2026-11-01', '2026-11-01T01:30:00.000Z', 2],
  ['Australia/Lord_Howe', '02:15', 7, '2026-09-27', '2026-10-11',
    '2026-10-10T15:15:00.000Z', 660, '2026-10-18', '2026-10-17T15:15:00.000Z', 2],
  ['Pacific/Apia', '00:00', 5, '2011-12-23', '2011-12-23', '2011-12-23T10:00:00.000Z',
    -600, '2012-01-06', '2012-01-05T10:00:00.000Z', 1],
  ['UTC', '09:00', 7, '2027-01-03', '2027-01-10', '2027-01-10T09:00:00.000Z',
    0, '2027-01-17', '2027-01-17T09:00:00.000Z', 2],
] as const;
async function calendar(zone: string, localTime: string, weekday: number, first: string,
  last: string, lastAt: string, offsetMinutes: number, nextDate: string, nextAt: string,
  count: number) {
  await save(creation(first, zone, localTime, weekday));
  now = Date.parse(nextAt) + 60_000;
  const request = { ...input, localDate: first };
  const receipt = await record(request);
  const row = await nats.store.readEvent(receipt.position);
  const expected = { count, firstLocalDate: first, lastLocalDate: last,
    cursor: { localDate: last, at: lastAt, offsetMinutes },
    next: { localDate: nextDate, at: nextAt } };
  expect(row.event.data).toMatchObject(expected);
  const dueInput = { ...input, expectedPosition: receipt.position, localDate: nextDate };
  await expect(record(dueInput)).rejects.toThrow(/^Routine missed refused$/u);
  await claimRoutineDue(nats.store, worker(), dueInput);
  expect((await state()).activeRun?.slot.at).toBe(nextAt);
}
it.each(calendars)('counts weekly %s slots once and preserves an eligible slot', calendar);

async function gapOnly(lateness: number) {
  const created = creation('2027-03-28');
  await save(created);
  now = Date.parse('2027-04-04T00:30:00.000Z') + lateness;
  const request = { ...input, localDate: '2027-03-28' };
  const [receipt, repeated] = await Promise.all([record(request), record(request)]);
  expect(repeated).toEqual(receipt);
  const row = await nats.store.readEvent(receipt.position);
  const next = { localDate: '2027-04-04', localTime: '02:30', zone: 'Europe/Brussels',
    at: '2027-04-04T00:30:00.000Z', offsetMinutes: 120 };
  expect(row.event.type).toBe('routine.occurrence_skipped');
  const expected = { localDate: '2027-03-28', reason: 'dst', cursor: null, next };
  expect(row.event.data).toMatchObject(expected);
  expect(row.event.data).not.toHaveProperty('count');
  expect((await state()).definition?.next).toEqual(next);
  expect(await record(request)).toEqual(receipt);
  expect(await nats.store.head()).toBe(3);
  const dueInput = { ...input, expectedPosition: receipt.position, localDate: '2027-04-04' };
  await claimRoutineDue(nats.store, worker(), dueInput);
  expect((await state()).activeRun?.slot).toEqual(next);
}
it.each([0, 60_000])('records just one weekly gap at recovery lateness %i ms', gapOnly);

async function bounded() {
  await save(creation('2023-01-01', 'UTC', '09:00'));
  now = Date.parse('2026-11-08T09:01:00.000Z');
  let request = { ...input, localDate: '2023-01-01' };
  const endpoints = [
    ['2023-01-01', '2024-11-24', '2024-12-01', 100],
    ['2024-12-01', '2026-10-25', '2026-11-01', 100],
    ['2026-11-01', '2026-11-01', '2026-11-08', 1],
  ] as const;
  for (const [first, last, next, count] of endpoints) {
    const receipt = await record(request);
    const row = await nats.store.readEvent(receipt.position);
    const data = routineMissedSchema.parse(row.event.data);
    const expected = { firstLocalDate: first, lastLocalDate: last, count,
      cursor: { localDate: last }, next: { localDate: next } };
    expect(data).toMatchObject(expected);
    expect(await record(request)).toEqual(receipt);
    request = { ...input, expectedPosition: receipt.position, localDate: next };
  }
  await expect(record(request)).rejects.toThrow(/^Routine missed refused$/u);
  expect(await nats.store.head()).toBe(5);
  expect((await state()).activeRun).toBeNull();
  expect((await state()).executionAvailable).toBe(false);
}
it('records 201 old weekly slots in 100, 100, 1 steps without recounting or starting work', bounded);

async function savedBoundary(kind: string) {
  const created = creation();
  const next = created.data.next!;
  if (kind === 'effective') {
    created.data.effectiveAt = next.at;
  } else if (kind === 'cursor') {
    created.data.cursor = next;
  } else if (kind === 'offset') {
    created.data.next = { ...next, offsetMinutes: 120 };
  } else if (kind === 'instant') {
    created.data.next = { ...next, at: '2027-03-21T02:30:00.000Z' };
  } else if (kind === 'weekday') {
    created.data.definition.schedule.weekday = 6;
  } else {
    created.data.next = null;
  }
  await save(created);
  now = Date.parse('2027-04-04T00:31:00.001Z');
  await expect(record()).rejects.toThrow();
  expect(await nats.store.head()).toBe(2);
}
it.each(['effective', 'cursor', 'offset', 'instant', 'weekday', 'missing next'])(
  'refuses a saved weekly %s mismatch without writing', savedBoundary);

async function scheduleEdit() {
  await save();
  const replacement = creation('2027-04-09', 'UTC', '09:00', 5);
  const data = { ...replacement.data, definitionRevision: 2, scheduleRevision: 2,
    controlRevision: 2, effectiveAt: '2027-04-02T09:00:00.000Z' };
  const updated = { ...replacement, id: 'edit', commandId: 'edit',
    type: 'routine.updated', data };
  await nats.seed([updated]);
  now = Date.parse('2027-04-16T09:01:00.000Z');
  const stale = { ...input, expectedPosition: 3 };
  await expect(record(stale)).rejects.toThrow(/^Routine missed refused$/u);
  const request = { ...stale, definitionRevision: 2, scheduleRevision: 2,
    controlRevision: 2, localDate: '2027-04-09' };
  const receipt = await record(request);
  const row = await nats.store.readEvent(receipt.position);
  const expected = { definitionRevision: 2, scheduleRevision: 2,
    controlRevision: 2, firstLocalDate: '2027-04-09', lastLocalDate: '2027-04-09',
    count: 1, next: { localDate: '2027-04-16' } };
  expect(row.event.data).toMatchObject(expected);
  expect(await nats.store.head()).toBe(4);
}
it('starts the edited weekday strictly after its effective time', scheduleEdit);

async function backwardsClock() {
  await save();
  now = Date.parse('2027-04-04T00:31:00.001Z');
  const append = nats.store.append.bind(nats.store);
  async function turnBack(...args: Parameters<typeof append>) {
    now -= 1;
    return append(...args);
  }
  const spy = vi.spyOn(nats.store, 'append');
  spy.mockImplementationOnce(turnBack);
  await expect(record()).rejects.toThrow(/^Routine missed refused$/u);
  expect(await nats.store.head()).toBe(2);
}
it('refuses a backwards clock at the final append check', backwardsClock);

async function recovery() {
  await save();
  now = Date.parse('2027-04-04T00:31:00.000Z');
  const append = nats.store.append.bind(nats.store);
  async function loseReply(...args: Parameters<typeof append>): Promise<never> {
    await append(...args);
    throw new Error('private-service-canary');
  }
  const spy = vi.spyOn(nats.store, 'append');
  spy.mockImplementationOnce(loseReply);
  await expect(record()).rejects.toThrow(/^Routine missed unavailable$/u);
  const row = await nats.store.readEvent(3);
  const original = { status: 'confirmed', eventId: row.event.id,
    position: row.sequence, executionAvailable: false };
  await waitForDuplicateWindow(nats);
  await nats.stop();
  await nats.restart();
  const connection = await nats.client('command');
  const restarted = await createEventStore(connection);
  now = Date.parse('2027-05-01T00:00:00.000Z');
  expect(await recordRoutineMissed(restarted, worker(), input)).toEqual(original);
  const changes = [{ definitionRevision: 2 }, { scheduleRevision: 2 },
    { controlRevision: 2 }, { localDate: '2027-03-28' }, { expectedPosition: 1 },
    { count: 2 }];
  for (const change of changes) {
    const request = { ...input, ...change };
    await expect(recordRoutineMissed(restarted, worker(), request)).rejects.toThrow();
  }
  expect(await restarted.head('routine-orders')).toBe(3);
  expect(JSON.stringify(row.event)).not.toMatch(/ciphertext|instructions|key:1|canary/u);
}
it('recovers the original weekly receipt after lost reply, dedupe expiry and restart', recovery);

async function refused(kind: string) {
  await save();
  now = Date.parse('2027-04-04T00:31:00.001Z');
  let request = input;
  if (kind === 'pause' || kind === 'retire' || kind === 'removal') {
    let change = routine('routine.paused');
    if (kind === 'retire') {
      change = routine('routine.retired');
    } else if (kind === 'removal') {
      change = event('removed', 'member-alice', 'member.removed');
    }
    await nats.seed([change]);
    request = { ...input, expectedPosition: await nats.store.head('routine-orders') };
  } else {
    const append = nats.store.append.bind(nats.store);
    async function cancel(...args: Parameters<typeof append>) {
      if (kind === 'lease') {
        owned = false;
      } else {
        stop.abort();
      }
      return append(...args);
    }
    const spy = vi.spyOn(nats.store, 'append');
    spy.mockImplementationOnce(cancel);
  }
  const before = await nats.store.head();
  await expect(record(request)).rejects.toThrow(/^Routine missed refused$/u);
  expect(await nats.store.head()).toBe(before);
}
it.each(['pause', 'retire', 'removal', 'cancellation', 'lease'])(
  'refuses weekly %s without writing', refused);
