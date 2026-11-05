import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createEventStore } from '@opencrane/event-store';
import { createStore, memberAuthorisation, type Binding } from '@opencrane/authz';
import { foldRoutine, handlerSubscriptions, routineMissedSchema, type EventEnvelope, type RoutineState } from '@opencrane/events';
import { calculateRoutineOccurrence } from '@opencrane/events/routine-schedule';
import { ProjectionRunner, rebuildRoutineProjection, routines } from '@opencrane/projections';
import { database } from '@opencrane/projections/testing';
import { createLogger } from '@opencrane/observability';
import { event } from '@opencrane/event-store/testing';
import { openfga } from '../../../libs/authz/test/services.ts';
import { routine, joinedMember } from '../../../libs/authz/test/routine-fixture.ts';
import { shortDuplicateWindowFixture, waitForDuplicateWindow }
  from '../../server/test/support/duplicate-window.ts';
import * as models from '@opencrane/models';
import * as tools from '../../../libs/models/src/mcp-dispatch.ts';
import { SandboxClient } from '../src/kubernetes.ts';
import { withRoutineLeadership } from '../src/routine-leadership.ts';
import { dispatchRoutineCandidates, scanRoutineCandidates } from '../src/routine-scan.ts';

let storage: Awaited<ReturnType<typeof database>>;
let nats: Awaited<ReturnType<typeof shortDuplicateWindowFixture>>;
let fga: Awaited<ReturnType<typeof openfga>>;
let binding: Binding;
let runner: ProjectionRunner;
let databaseUrl: string;
let stop: AbortController;
let now: number;
let leaseSignal: AbortSignal;
function forbiddenEffect(): never {
  throw new Error('Forbidden routine effect');
}
const forbidden = vi.fn(forbiddenEffect);
const loggerOptions = { level: 'silent' };
const logger = createLogger('routine-dispatch-test', loggerOptions);
type Lease = Parameters<Parameters<typeof withRoutineLeadership>[1]>[0];
type Progress = Awaited<ReturnType<typeof scanRoutineCandidates>>;

async function setup() {
  storage = await database('pg');
  const current = await storage.db.query<{ name: string }>('SELECT current_database() AS name');
  const address = new URL(process.env['PG_TEST_URL']!);
  address.pathname = `/${current.rows[0]!.name}`;
  databaseUrl = address.href;
  nats = await shortDuplicateWindowFixture();
  fga = await openfga();
  binding = await createStore(fga.apiUrl, 'test');
  runner = new ProjectionRunner(storage.db, nats.reader, logger);
  await runner.initialise(routines);
  stop = new AbortController();
  now = Date.parse('2027-03-27T09:00:00.000Z');
  const joined = joinedMember('alice');
  await save([joined]);
  forbidden.mockClear();
  vi.spyOn(models, 'startGateway').mockImplementation(forbidden);
  vi.spyOn(tools, 'mcpDispatch').mockImplementation(forbidden);
  vi.spyOn(SandboxClient.prototype, 'mode').mockImplementation(forbidden);
}
async function cleanup() {
  expect(forbidden).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  await fga?.close();
  await nats?.close();
  await storage?.close();
}
beforeEach(setup, 30_000);
afterEach(cleanup);
function clock() {
  return now;
}
function creation(localDate = '2027-03-27', zone = 'UTC', localTime = '09:00') {
  const original = routine('routine.created');
  const saved = foldRoutine(undefined, original).definition!;
  const schedule = { frequency: 'daily' as const, zone, localTime };
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
  const data = { ...saved, definition, status: 'active', effectiveAt, next };
  return { ...original, time: effectiveAt, data };
}
async function save(events: EventEnvelope[]) {
  await nats.seed(events);
  const auth = memberAuthorisation(binding, nats.store);
  for (const saved of events) {
    const supported: readonly string[] = handlerSubscriptions['update-openfga'];
    if (supported.includes(saved.type)) {
      await auth.handler.handle(saved, storage.db);
    }
  }
  await runner.run(routines);
}
async function dispatch(continuation: Progress['continuation'] = null) {
  let result: Progress | undefined;
  async function work(lease: Lease) {
    leaseSignal = lease.signal;
    const worker = { ...lease, silo: 'test', binding, now: clock, continuation };
    result = await dispatchRoutineCandidates(storage.db, nats.store, worker);
  }
  const options = { databaseUrl, silo: 'test', signal: stop.signal };
  await withRoutineLeadership(options, work);
  return result!;
}
async function state() {
  let result: RoutineState | undefined;
  for await (const row of nats.store.readStream('routine-orders')) {
    result = foldRoutine(result, row.event);
  }
  return result!;
}
async function recoversDue() {
  const created = creation();
  await save([created]);
  const append = nats.store.append.bind(nats.store);
  async function loseReply(...args: Parameters<typeof append>): Promise<never> {
    await append(...args);
    throw new Error('private-service-canary');
  }
  vi.spyOn(nats.store, 'append').mockImplementationOnce(loseReply);
  await expect(dispatch()).rejects.toThrow(/^Routine leadership unavailable$/u);
  const original = (await state()).activeRun!;
  expect(original.startBy).toBe('2027-03-27T09:01:00.000Z');
  expect(await nats.store.head('routine-orders')).toBe(3);
  await waitForDuplicateWindow(nats);
  nats.store = await createEventStore(nats.connection);
  await runner.run(routines);
  await dispatch();
  expect((await state()).activeRun).toEqual(original);
  expect(await nats.store.head('routine-orders')).toBe(3);
}
it('recovers the saved due and original startBy after restart, lost reply and dedupe expiry',
  recoversDue);

const calendars = [
  ['2027-03-28', 'Europe/Brussels', '02:30', '2027-03-28T01:00:00Z', 'occurrence_skipped'],
  ['2011-12-30', 'Pacific/Apia', '00:00', '2011-12-30T10:00:00Z', 'occurrence_skipped'],
  ['2026-10-25', 'Europe/Brussels', '02:30', '2026-10-25T00:31:00Z', 'due'],
  ['2026-10-25', 'Europe/Brussels', '02:30', '2026-10-25T00:31:00.001Z', 'occurrences_missed'],
  ['2027-03-27', 'UTC', '09:00', '2027-03-27T08:59:59Z', 'created'],
] as const;
async function calendar(localDate: string, zone: string, localTime: string,
  instant: string, expected: string) {
  const created = creation(localDate, zone, localTime);
  await save([created]);
  now = Date.parse(instant);
  expect((await dispatch()).examined).toBe(1);
  const position = await nats.store.head('routine-orders');
  expect((await nats.store.readEvent(position)).event.type).toBe(`routine.${expected}`);
}
it.each(calendars)('dispatches %s %s %s at %s as %s', calendar);

async function occupiedAndInactive() {
  const created = creation();
  await save([created]);
  await dispatch();
  const original = (await state()).activeRun;
  const next = creation('2027-03-28');
  const edit = { ...next, id: 'edit', commandId: 'edit', type: 'routine.updated' };
  await save([edit]);
  now = Date.parse('2027-03-28T09:00:00Z');
  expect((await dispatch()).counts.occupied).toBe(1);
  expect((await state()).activeRun).toEqual(original);
  expect((await state()).definition!.cursor!.localDate).toBe('2027-03-28');
  for (const type of ['routine.paused', 'routine.retired']) {
    const control = routine(type);
    await save([control]);
    const before = await nats.store.head();
    expect((await dispatch()).counts.inactive).toBe(1);
    expect(await nats.store.head()).toBe(before);
  }
}
it('skips only the occupied next slot and leaves inactive routines alone', occupiedAndInactive);

async function missedProgress() {
  const created = creation('2027-01-01');
  await save([created]);
  now = Date.parse('2027-07-21T09:01:00Z');
  const counts: number[] = [];
  for (let index = 0; index < 3; index += 1) {
    expect((await dispatch()).counts.late).toBe(1);
    const position = await nats.store.head('routine-orders');
    const saved = await nats.store.readEvent(position);
    counts.push(routineMissedSchema.parse(saved.event.data).count);
    await runner.run(routines);
  }
  expect(counts).toEqual([100, 100, 1]);
  expect((await state()).activeRun).toBeNull();
  expect((await state()).definition!.next!.localDate).toBe('2027-07-21');
}
it('continues bounded daily ranges without recounting or starting old work', missedProgress);

async function refusesWeekly() {
  const created = creation();
  const schedule = { ...created.data.definition.schedule, frequency: 'weekly' as const,
    weekday: 6 };
  const definition = { ...created.data.definition, schedule };
  const data = { ...created.data, definition };
  const weekly = { ...created, data };
  await save([weekly]);
  now += 60_001;
  await expect(dispatch()).rejects.toThrow('Routine leadership unavailable');
  expect(await nats.store.head()).toBe(2);
}
it('refuses late weekly work until its downtime writer exists', refusesWeekly);

async function changedDuringPreparation(kind: string) {
  const created = creation();
  await save([created]);
  const read = nats.store.readStream.bind(nats.store);
  let routineReads = 0;
  async function* changed(...args: Parameters<typeof read>) {
    if (args[0] === 'routine-orders') {
      routineReads += 1;
      if (routineReads === 2) {
        let change = routine('routine.paused');
        if (kind === 'removed') {
          change = event('removed', 'member-alice', 'member.removed');
        } else if (kind === 'retired') {
          change = routine('routine.retired');
        } else if (kind === 'updated') {
          const replacement = creation('2027-03-28');
          change = { ...replacement, id: 'edit', commandId: 'edit', type: 'routine.updated' };
        }
        await nats.seed([change]);
      }
    }
    yield* read(...args);
  }
  vi.spyOn(nats.store, 'readStream').mockImplementation(changed);
  await expect(dispatch()).rejects.toThrow('Routine leadership unavailable');
  expect(await nats.store.head()).toBe(3);
  expect((await state()).activeRun).toBeNull();
}
it.each(['paused', 'updated', 'retired', 'removed'])(
  'refuses %s after selection and before the checked command', changedDuringPreparation);

async function racingScans() {
  const created = creation();
  await save([created]);
  async function work(lease: Lease) {
    const worker = { ...lease, binding, silo: 'test', now: clock };
    const first = dispatchRoutineCandidates(storage.db, nats.store, worker);
    const second = dispatchRoutineCandidates(storage.db, nats.store, worker);
    await Promise.allSettled([first, second]);
  }
  const options = { databaseUrl, silo: 'test', signal: stop.signal };
  await Promise.all([withRoutineLeadership(options, work), withRoutineLeadership(options, work)]);
  expect(await nats.store.head('routine-orders')).toBe(3);
  expect((await state()).activeRun!.startBy).toBe('2027-03-27T09:01:00.000Z');
}
it('keeps one saved due through two leaders and racing scans', racingScans);

async function cancellation(stage: string) {
  const created = creation();
  await save([created]);
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const read = nats.store.readStream.bind(nats.store);
  const append = nats.store.append.bind(nats.store);
  const head = nats.store.head.bind(nats.store);
  let reads = 0;
  let appending = false;
  async function hold() {
    entered.resolve();
    await resume.promise;
  }
  async function* preparation(...args: Parameters<typeof read>) {
    if (args[0] === 'routine-orders') {
      reads += 1;
      if (reads === 2 && (stage === 'preparation' || stage === 'shutdown')) {
        await hold();
      }
    }
    yield* read(...args);
  }
  async function appendChecked(...args: Parameters<typeof append>) {
    appending = true;
    const change = args[0];
    async function checkAccess() {
      await change.checkAccess!();
      if (stage === 'after-access') {
        await hold();
      }
    }
    const checked = { ...change, checkAccess };
    return append(checked);
  }
  async function accessHead(...args: Parameters<typeof head>) {
    if (appending && stage === 'access' && args[0] === 'member-alice') {
      await hold();
    }
    return head(...args);
  }
  vi.spyOn(nats.store, 'readStream').mockImplementation(preparation);
  vi.spyOn(nats.store, 'append').mockImplementation(appendChecked);
  vi.spyOn(nats.store, 'head').mockImplementation(accessHead);
  let settled = false;
  function finished() {
    settled = true;
  }
  const pending = dispatch();
  void pending.then(finished, finished);
  const rejected = expect(pending).rejects.toThrow('Routine leadership unavailable');
  await entered.promise;
  try {
    if (stage === 'shutdown') {
      stop.abort();
    } else {
      await storage.db.query(`SELECT pg_terminate_backend(pid) FROM pg_locks
        WHERE locktype = 'advisory' AND granted AND
        classid = (hashtextextended('opencrane:projection:routine-leader:test', 0) >> 32)::int
        AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`);
    }
    function cancelled() {
      expect(leaseSignal.aborted).toBe(true);
    }
    await vi.waitFor(cancelled);
    expect(settled).toBe(false);
  } finally {
    resume.resolve();
  }
  await rejected;
  expect(await nats.store.head()).toBe(2);
}
it.each(['preparation', 'access', 'after-access', 'shutdown'])(
  'drains awaited work and saves no stale event on %s cancellation', cancellation);

async function refusesUnsafeAppend(status: 'conflict' | 'unavailable') {
  const created = creation();
  await save([created]);
  const result = { status, cause: new Error('private-service-canary') };
  vi.spyOn(nats.store, 'append').mockResolvedValueOnce(result);
  await expect(dispatch()).rejects.toThrow('Routine leadership unavailable');
  expect(await nats.store.head()).toBe(2);
}
it.each(['conflict', 'unavailable'] as const)(
  'never reports completed progress for an unsafe %s result', refusesUnsafeAppend);

async function pageBudget() {
  const first = creation();
  const secondData = { ...first.data, routineId: 'second' };
  const second = { ...first, id: 'second', commandId: 'second', subject: 'routine-second',
    data: secondData };
  await save([first, second]);
  const monotonic = performance.now.bind(performance);
  let elapsed = 0;
  function elapsedTime() {
    return monotonic() + elapsed;
  }
  vi.spyOn(performance, 'now').mockImplementation(elapsedTime);
  const read = nats.store.readStream.bind(nats.store);
  let reads = 0;
  async function* preparation(...args: Parameters<typeof read>) {
    reads += 1;
    if (reads === 2) {
      elapsed = 9100;
    }
    yield* read(...args);
  }
  vi.spyOn(nats.store, 'readStream').mockImplementation(preparation);
  const result = await dispatch();
  expect(result.examined).toBe(1);
  expect(result.continuation?.afterRoutineId).toBe('orders');
  expect(await nats.store.head('routine-second')).toBe(3);
}
it('stops admitting candidates at the page budget and keeps only awaited progress', pageBudget);

async function readOnlyAndReplay() {
  const created = creation();
  await save([created]);
  await rebuildRoutineProjection(storage.db, nats.reader, logger);
  async function work(lease: Lease) {
    const worker = { ...lease, silo: 'test', now: clock };
    expect((await scanRoutineCandidates(storage.db, nats.store, worker)).counts.eligible).toBe(1);
  }
  const options = { databaseUrl, silo: 'test', signal: stop.signal };
  await withRoutineLeadership(options, work);
  expect(await nats.store.head()).toBe(2);
}
it('keeps read-only invocation and replay free of commands and execution effects', readOnlyAndReplay);
