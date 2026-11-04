import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { foldRoutine, type EventEnvelope, type RoutineState } from '@opencrane/events';
import { createStore, memberAuthorisation, type Binding } from '@opencrane/authz';
import { createEventStore, type AppendCommand } from '@opencrane/event-store';
import { event } from '@opencrane/event-store/testing';
import { connectProjectionDb } from '@opencrane/projections';
import { TupleClient, objectId } from '../../../libs/authz/src/client.ts';
import { openfga } from '../../../libs/authz/test/services.ts';
import { routine, joinedMember } from '../../../libs/authz/test/routine-fixture.ts';
import { shortDuplicateWindowFixture, waitForDuplicateWindow }
  from '../../server/test/support/duplicate-window.ts';
import { routineAsk } from '../../server/test/support/routine-ask.ts';
import { claimRoutineDue } from '../src/routine-due.ts';
import { withRoutineLeadership } from '../src/routine-leadership.ts';
import { skipRoutineOccurrence } from '../src/routine-skip.ts';

let nats: Awaited<ReturnType<typeof shortDuplicateWindowFixture>>;
let fga: Awaited<ReturnType<typeof openfga>>;
let binding: Binding;
let now: number;
let owned: boolean;
let stop: AbortController;
const input = { routineId: 'orders', expectedPosition: 2, localDate: '2027-03-28',
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
  const schedule = { frequency: 'weekly' as const, weekday: 7,
    localTime: '02:30', zone: 'Europe/Brussels' };
  const definition = { ...example.definition, schedule };
  const data = { ...example, status: 'active' as const, definition,
    effectiveAt: '2027-03-27T12:00:00.000Z', next: null };
  return { ...routine('routine.created'), time: data.effectiveAt, data };
}
async function setup() {
  nats = await shortDuplicateWindowFixture();
  fga = await openfga();
  binding = await createStore(fga.apiUrl, 'test');
  now = Date.parse('2027-03-28T01:00:00.000Z');
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
function ignoreError() {
  // Expect the database connection to report an error when the test ends its session.
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
function skip(request = input) {
  return skipRoutineOccurrence(nats.store, worker(), request);
}
async function state() {
  let saved: RoutineState | undefined;
  for await (const row of nats.store.readStream('routine-orders')) {
    saved = foldRoutine(saved, row.event);
  }
  return saved!;
}
async function dst() {
  const [first, second] = await Promise.all([skip(), skip()]);
  expect(second).toEqual(first);
  expect(first.executionAvailable).toBe(false);
  const row = await nats.store.readEvent(first.position);
  expect(row.event.type).toBe('routine.occurrence_skipped');
  expect(row.event.time).toBe('2027-03-28T01:00:00.000Z');
  const expected = { reason: 'dst', cursor: null,
    next: { at: '2027-04-04T00:30:00.000Z', localDate: '2027-04-04' } };
  expect(row.event.data).toMatchObject(expected);
  expect(await nats.store.head()).toBe(3);
  const replayed = await state();
  expect(replayed.activeRun).toBeNull();
  expect(replayed.executionAvailable).toBe(false);
  expect(JSON.stringify(first)).not.toMatch(/ciphertext|instructions|key:1/u);
}
it('saves one gap at its boundary, advances without shifting it and replays without work', dst);

const dailyGaps = [
  {
    zone: 'Pacific/Apia', localTime: '00:00', localDate: '2011-12-30',
    effectiveAt: '2011-12-29T12:00:00.000Z', checkAt: '2011-12-30T10:00:00.000Z',
    next: { localDate: '2011-12-31', localTime: '00:00', zone: 'Pacific/Apia',
      at: '2011-12-30T10:00:00.000Z', offsetMinutes: 840 },
  },
  {
    zone: 'Europe/Brussels', localTime: '02:30', localDate: '2027-03-28',
    effectiveAt: '2027-03-27T12:00:00.000Z', checkAt: '2027-03-28T01:00:00.000Z',
    next: { localDate: '2027-03-29', localTime: '02:30', zone: 'Europe/Brussels',
      at: '2027-03-29T00:30:00.000Z', offsetMinutes: 120 },
  },
];
async function dailyGapBoundary(gap: typeof dailyGaps[number]) {
  const original = creation();
  const schedule = { frequency: 'daily' as const, localTime: gap.localTime, zone: gap.zone };
  const definition = { ...original.data.definition, schedule };
  const data = { ...original.data, definition, effectiveAt: gap.effectiveAt };
  const updated = { ...original, id: 'daily-gap', commandId: 'daily-gap',
    type: 'routine.updated', time: gap.effectiveAt, data };
  await nats.seed([updated]);
  now = Date.parse(gap.checkAt);
  const request = { ...input, localDate: gap.localDate, expectedPosition: 3 };

  const receipt = await skip(request);

  expect(receipt.executionAvailable).toBe(false);
  const row = await nats.store.readEvent(receipt.position);
  expect(row.event.type).toBe('routine.occurrence_skipped');
  expect(row.event.time).toBe(gap.checkAt);
  const expected = { reason: 'dst', localDate: gap.localDate, localTime: gap.localTime,
    zone: gap.zone, cursor: null, next: gap.next };
  expect(row.event.data).toMatchObject(expected);
  const replayed = await state();
  expect(replayed.definition?.next).toEqual(gap.next);
  expect(replayed.definition?.cursor).toBeNull();
  expect(replayed.activeRun).toBeNull();
  expect(replayed.executionAvailable).toBe(false);
  expect(await skip(request)).toEqual(receipt);
  expect(await nats.store.head()).toBe(4);
}
it.each(dailyGaps)(
  'keeps the next daily local slot when skipping the $zone gap at its boundary', dailyGapBoundary);

async function occupied(kind = 'starting') {
  const original = creation();
  const next = { localDate: '2026-10-18', localTime: '02:30', zone: 'Europe/Brussels',
    at: '2026-10-18T00:30:00.000Z', offsetMinutes: 120 };
  const data = { ...original.data, next, effectiveAt: '2026-10-17T12:00:00.000Z' };
  const updated = { ...original, id: 'earlier', commandId: 'earlier',
    type: 'routine.updated', time: data.effectiveAt, data };
  await nats.seed([updated]);
  now = Date.parse(next.at);
  const request = { ...input, localDate: next.localDate, expectedPosition: 3 };
  const claimed = await claimRoutineDue(nats.store, worker(), request);
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
  const following = { ...next, localDate: '2026-10-25', at: '2026-10-25T00:30:00.000Z' };
  const advance = { ...updated, id: 'following', commandId: 'following',
    data: { ...data, cursor: next, next: following } };
  await nats.seed([advance]);
  now = Date.parse(following.at);
  return { ...input, expectedPosition: await nats.store.head('routine-orders'),
    localDate: following.localDate };
}
async function overlap(kind: string) {
  const request = await occupied(kind);
  const before = await state();
  const [receipt, repeated] = await Promise.all([skip(request), skip(request)]);
  expect(repeated).toEqual(receipt);
  const after = await state();
  expect(after.activeRun).toEqual(before.activeRun);
  expect(after.activation).toEqual(before.activation);
  expect(after.stopRequested).toBe(before.stopRequested);
  expect(after.definition?.cursor?.at).toBe('2026-10-25T00:30:00.000Z');
  expect(after.definition?.next?.at).toBe('2026-11-01T01:30:00.000Z');
  expect(await skip(request)).toEqual(receipt);
}
it.each(['starting', 'running', 'Ask', 'stopping'])('preserves an occupied %s run', overlap);
async function timing(offset: number, overlapSlot: boolean) {
  let request = input;
  if (overlapSlot) {
    request = await occupied();
  }
  now += offset;
  const before = await nats.store.head();
  await expect(skip(request)).rejects.toThrow(/^Routine skip refused$/u);
  expect(await nats.store.head()).toBe(before);
}
it.each([[-1, false], [-1, true], [60_001, true], [3_600_000, true]])(
  'refuses timing offset %i, overlap %s', timing);
async function invalid(kind: string) {
  const created = creation();
  const data = { ...created.data };
  let changed: EventEnvelope = { ...created, id: 'changed', commandId: 'changed',
    type: 'routine.updated', data };
  if (kind === 'paused') {
    changed.data = { ...data, status: 'paused' };
  } else if (kind === 'retired') {
    changed = { ...routine('routine.retired'), id: 'changed' };
  } else if (kind === 'legacy') {
    changed.data = { routineId: 'orders', schedule: '* * * * *', updatedBy: 'alice' };
  } else if (kind === 'cursor') {
    const cursor = { localDate: input.localDate, localTime: '02:30', zone: 'Europe/Brussels',
      at: '2027-03-28T01:00:00Z', offsetMinutes: 120 };
    changed.data = { ...data, cursor };
  } else if (kind === 'real') {
    const schedule = { ...data.definition.schedule, localTime: '03:00' };
    const definition = { ...data.definition, schedule };
    changed.data = { ...data, definition };
  } else {
    changed.data = { ...data, [kind]: 2 };
  }
  await nats.seed([changed]);
  const request = { ...input, expectedPosition: await nats.store.head('routine-orders') };
  await expect(skip(request)).rejects.toThrow();
  expect(await nats.store.head()).toBe(request.expectedPosition);
}
it.each(['paused', 'retired', 'legacy', 'cursor', 'real', 'definitionRevision',
  'scheduleRevision', 'controlRevision'])('refuses changed %s', invalid);
async function idle() {
  const request = await occupied();
  const run = (await state()).activeRun!;
  const { definition: _definition, source: _source, slot: _slot,
    firedAt: _firedAt, startBy: _startBy, ...binding } = run;
  const data = { ...binding, outcome: 'cancelled', reason: 'root_stopped',
    terminalEvidence: { eventId: 'closed', position: 1 } };
  const finished = { ...creation(), id: 'finished', commandId: 'finished',
    type: 'routine.run_finished', principal: { kind: 'system' as const, id: 'opencrane-server' }, data };
  await nats.seed([finished]);
  request.expectedPosition = await nats.store.head('routine-orders');
  await expect(skip(request)).rejects.toThrow();
}
it('refuses overlap without an occupied run', idle);
async function recovery() {
  const append = nats.store.append.bind(nats.store);
  async function loseReply(change: AppendCommand): Promise<never> {
    await append(change);
    throw new Error('private-service-canary');
  }
  const spy = vi.spyOn(nats.store, 'append');
  spy.mockImplementationOnce(loseReply);
  await expect(skip()).rejects.toThrow(/^Routine skip unavailable$/u);
  const first = await skip();
  await waitForDuplicateWindow(nats);
  await nats.stop();
  await nats.restart();
  const connection = await nats.client('command');
  const restarted = await createEventStore(connection);
  now += 86_400_000;
  expect(await skipRoutineOccurrence(restarted, worker(), input)).toEqual(first);
  const changes = [{ definitionRevision: 2 }, { scheduleRevision: 2 }, { controlRevision: 2 },
    { localDate: '2027-04-04' }, { expectedPosition: first.position }, { reason: 'overlap' }];
  for (const change of changes) {
    const request = { ...input, ...change };
    await expect(skipRoutineOccurrence(restarted, worker(), request)).rejects.toThrow();
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
    await skip();
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
  await expect(skip()).rejects.toThrow(/^Routine skip refused$/u);
  const saved = await state();
  expect(saved.definition?.next !== null).toBe(phase !== 'before');
  if (phase === 'after') {
    expect(await nats.store.head('routine-orders')).toBe(before + 1);
  }
}
it.each(['before', 'retry', 'after'])('refuses owner removal %s', access.bind(null, 'member'));
it.each(['before', 'retry', 'after'])('refuses lost leadership %s', access.bind(null, 'worker'));
it.each(['before', 'retry', 'after'])('refuses cancellation %s', access.bind(null, 'signal'));
it.each(['before', 'retry', 'after'])('refuses missing receipts %s', access.bind(null, 'receipt'));
async function backwards() {
  now += 10_000;
  const append = nats.store.append.bind(nats.store);
  async function reverseClock(change: AppendCommand) {
    now -= 1;
    return append(change);
  }
  const spy = vi.spyOn(nats.store, 'append');
  spy.mockImplementationOnce(reverseClock);
  await expect(skip()).rejects.toThrow(/^Routine skip refused$/u);
  expect(await nats.store.head()).toBe(2);
}
it('refuses a clock moving backwards during append', backwards);
async function cancelled(afterAccess: boolean) {
  let checked = false;
  const options = { databaseUrl: process.env['PG_TEST_URL']!,
    silo: 'skip-command-test', signal: stop.signal };
  async function work(lease: Parameters<Parameters<typeof withRoutineLeadership>[1]>[0]) {
    const append = nats.store.append.bind(nats.store);
    const head = nats.store.head.bind(nats.store);
    let appending = false;
    async function loseSession() {
      const admin = connectProjectionDb(options.databaseUrl, ignoreError);
      try {
        await admin.db.query(`SELECT pg_terminate_backend(pid) FROM pg_locks
          WHERE locktype = 'advisory' AND granted AND
          classid = (hashtextextended('opencrane:projection:routine-leader:skip-command-test', 0) >> 32)::int
          AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`);
        function aborted() {
          expect(lease.signal.aborted).toBe(true);
        }
        await vi.waitFor(aborted);
      } finally {
        await admin.close();
      }
    }
    async function observedAppend(change: AppendCommand) {
      appending = true;
      async function checkAccess() {
        await change.checkAccess!();
        if (afterAccess) {
          await loseSession();
        }
      }
      const checked = { ...change, checkAccess };
      return append(checked);
    }
    async function readHead(...args: Parameters<typeof head>) {
      if (!afterAccess && appending && args[0] === 'member-alice') {
        await loseSession();
      }
      return head(...args);
    }
    const appendSpy = vi.spyOn(nats.store, 'append');
    appendSpy.mockImplementationOnce(observedAppend);
    const headSpy = vi.spyOn(nats.store, 'head');
    headSpy.mockImplementation(readHead);
    const trusted = { ...worker(), ...lease };
    await expect(skipRoutineOccurrence(nats.store, trusted, input)).rejects.toThrow();
    expect(await nats.store.head()).toBe(2);
    checked = true;
  }
  await expect(withRoutineLeadership(options, work)).rejects.toThrow(
    /^Routine leadership unavailable$/u);
  expect(checked).toBe(true);
}
it.each([false, true])('refuses session loss during append, after access %s', cancelled);
