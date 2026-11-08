import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
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
import { runRoutineScheduler } from '../src/routine-production.ts';

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
  const startGatewaySpy = vi.spyOn(models, 'startGateway');
  startGatewaySpy.mockImplementation(forbidden);
  const mcpDispatchSpy = vi.spyOn(tools, 'mcpDispatch');
  mcpDispatchSpy.mockImplementation(forbidden);
  const sandboxModeSpy = vi.spyOn(SandboxClient.prototype, 'mode');
  sandboxModeSpy.mockImplementation(forbidden);
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
async function production(options: { enabled?: boolean; replay?: boolean },
  handoff?: Parameters<typeof dispatchRoutineCandidates>[3]) {
  let result: Awaited<ReturnType<typeof runRoutineScheduler>> | undefined;
  async function work(lease: Lease) {
    leaseSignal = lease.signal;
    const worker = { ...lease, silo: 'test', binding, now: clock };
    if (handoff) {
      const delivery = { db: storage.db, store: nats.store, worker, handoff };
      result = await runRoutineScheduler(options, delivery);
    } else {
      result = await runRoutineScheduler(options);
    }
  }
  const leadership = { databaseUrl, silo: 'test', signal: stop.signal };
  await withRoutineLeadership(leadership, work);
  return result!;
}
async function disabledProductionDoesNotClaim() {
  await save([creation()]);
  const before = await nats.store.head('routine-orders');
  const handoff: NonNullable<Parameters<typeof dispatchRoutineCandidates>[3]> =
    function refuseDelivery() {
      return Promise.reject(new Error('Unexpected routine delivery'));
    };
  const result = await production({}, handoff);
  expect(result).toEqual({ status: 'disabled', executionAvailable: false });
  expect(await nats.store.head('routine-orders')).toBe(before);
  expect((await state()).activeRun).toBeNull();
  await production({ enabled: true, replay: true }, handoff);
  expect(await nats.store.head('routine-orders')).toBe(before);
  expect(await nats.store.head('budget-test')).toBe(0);
}
it('keeps the production entry read only by default and during replay',
  disabledProductionDoesNotClaim);

async function enabledProductionNeedsDelivery() {
  await save([creation()]);
  const before = await nats.store.head('routine-orders');
  await expect(runRoutineScheduler({ enabled: true }))
    .rejects.toThrow(/^Routine delivery unavailable$/u);
  function current() {
    return Promise.resolve(true);
  }
  function handoff() {
    return Promise.resolve({ status: 'sent' as const });
  }
  const worker = { silo: 'test', binding, signal: stop.signal, checkCurrent: current };
  const delivery = { db: storage.db, store: nats.store, worker, handoff };
  Reflect.deleteProperty(delivery, 'handoff');
  await expect(runRoutineScheduler({ enabled: true }, delivery))
    .rejects.toThrow(/^Routine delivery unavailable$/u);
  expect(await nats.store.head('routine-orders')).toBe(before);
  expect((await state()).activeRun).toBeNull();
}
it('refuses an enabled host without a checked delivery callback before claiming a slot',
  enabledProductionNeedsDelivery);

async function workerSetting(setting: string | undefined,
  custody: 'valid' | 'missing-directory' | 'missing-wrap' | 'invalid-wrap' = 'valid') {
  await nats.seed([creation()]);
  const before = await nats.store.head('routine-orders');
  const env: NodeJS.ProcessEnv = { ...process.env, ...nats.env('projection'),
    DATABASE_URL: databaseUrl, SILO_ID: 'test', LOG_LEVEL: 'info' };
  delete env['ROUTINE_EXECUTION_ENABLED'];
  delete env['CONVERSATION_KEYS_DIR'];
  delete env['CONVERSATION_WRAP_KEY_FILE'];
  const directory = await mkdtemp('/tmp/private-routine-custody-path-');
  const keyDirectory = `${directory}/keys`;
  const wrappingKeyFile = `${directory}/wrap-key`;
  if (custody !== 'missing-directory') await mkdir(keyDirectory);
  if (custody !== 'missing-wrap') {
    const wrappingBytes = custody === 'invalid-wrap'
      ? 'private-routine-custody-canary'
      : 'private-routine-custody-canary'.padEnd(32, '!');
    await writeFile(wrappingKeyFile, wrappingBytes, { mode: 0o600 });
  }
  env['CONVERSATION_KEYS_DIR'] = keyDirectory;
  env['CONVERSATION_WRAP_KEY_FILE'] = wrappingKeyFile;
  if (setting !== undefined) {
    env['ROUTINE_EXECUTION_ENABLED'] = setting;
  }
  const args = ['--experimental-strip-types', 'apps/ops/src/worker.ts', 'routines'];
  const child = spawn(process.execPath, args, { env });
  let output = '';
  function collect(chunk: Buffer) {
    output += chunk.toString();
  }
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);
  const exited = once(child, 'exit');
  try {
    if (setting === undefined || setting === 'false') {
      async function projected() {
        if (child.exitCode !== null) {
          throw new Error(output);
        }
        const saved = await storage.db.query<{ sequence: string }>(
          "SELECT sequence FROM projection_checkpoints WHERE name='routines'");
        return Number(saved.rows[0]?.sequence) === await nats.store.head();
      }
      await expect.poll(projected, { timeout: 20_000, interval: 100 }).toBe(true);
      expect(child.exitCode).toBeNull();
      child.kill('SIGTERM');
      await exited;
      expect(child.exitCode).toBe(0);
    } else {
      function stopped() {
        return child.exitCode !== null;
      }
      await expect.poll(stopped, { timeout: 10_000, interval: 100 }).toBe(true);
      await exited;
      expect(child.exitCode).toBe(1);
      if (setting === 'true') {
        const expected = custody === 'valid'
          ? 'Routine delivery unavailable' : 'Routine custody unavailable';
        expect(output).toContain(expected);
      } else {
        expect(output).toContain('ROUTINE_EXECUTION_ENABLED must be true or false');
      }
    }
    expect(await nats.store.head('routine-orders')).toBe(before);
    expect((await state()).activeRun).toBeNull();
    expect(await nats.store.head('budget-test')).toBe(0);
    expect(forbidden).not.toHaveBeenCalled();
    expect(output).not.toContain('private-routine-custody-canary');
    expect(output).not.toContain(directory);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await exited;
    }
    await rm(directory, { recursive: true, force: true });
  }
}
async function workerSettingCase(setting: string | undefined) {
  await workerSetting(setting);
}
it.each([undefined, 'false', 'true', 'invalid'])(
  'starts the routines worker with execution setting %s', workerSettingCase);
async function disabledWithoutCustody(setting: string | undefined) {
  await workerSetting(setting, 'missing-directory');
}
it.each([undefined, 'false'])(
  'keeps disabled startup read-only without custody: %s', disabledWithoutCustody);
async function missingCustodyCase(
  custody: 'missing-directory' | 'missing-wrap' | 'invalid-wrap') {
  await workerSetting('true', custody);
}
it.each(['missing-directory', 'missing-wrap', 'invalid-wrap'] as const)(
  'refuses enabled startup with %s before a claim', missingCustodyCase);

async function enabledProductionHandsOffSavedDue() {
  await save([creation()]);
  const seen: string[] = [];
  const handoff: NonNullable<Parameters<typeof dispatchRoutineCandidates>[3]> =
    function receive(due, lease) {
      expect(lease.signal).toBe(leaseSignal);
      expect(due.routineId).toBe('orders');
      seen.push(due.occurrenceId);
      return Promise.resolve({ status: 'sent' });
    };
  const result = await production({ enabled: true }, handoff);
  expect(result).toMatchObject({ examined: 1, executionAvailable: false });
  expect(seen).toEqual([(await state()).activeRun!.occurrenceId]);
}
it('passes one confirmed due under the existing leadership session when enabled',
  enabledProductionHandsOffSavedDue);
async function recoversDue() {
  const created = creation();
  await save([created]);
  const append = nats.store.append.bind(nats.store);
  async function loseReply(...args: Parameters<typeof append>): Promise<never> {
    await append(...args);
    throw new Error('private-service-canary');
  }
  const appendSpy = vi.spyOn(nats.store, 'append');
  appendSpy.mockImplementationOnce(loseReply);
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

async function weeklyDowntime() {
  const created = creation();
  const schedule = { ...created.data.definition.schedule, frequency: 'weekly' as const,
    weekday: 6 };
  const definition = { ...created.data.definition, schedule };
  const data = { ...created.data, definition };
  const weekly = { ...created, data };
  await save([weekly]);
  now += 60_001;
  expect((await dispatch()).counts.late).toBe(1);
  expect(await nats.store.head()).toBe(3);
  const row = await nats.store.readEvent(3);
  expect(row.event.type).toBe('routine.occurrences_missed');
  const expected = { firstLocalDate: '2027-03-27',
    lastLocalDate: '2027-03-27', count: 1, cursor: weekly.data.next,
    next: { localDate: '2027-04-03', at: '2027-04-03T09:00:00.000Z' } };
  expect(row.event.data).toMatchObject(expected);
  expect((await state()).activeRun).toBeNull();
  await runner.run(routines);
  const before = await storage.db.query('SELECT * FROM routine_occurrences');
  const savedState = await storage.db.query('SELECT * FROM routines');
  await rebuildRoutineProjection(storage.db, nats.reader, logger);
  const after = await storage.db.query('SELECT * FROM routine_occurrences');
  const rebuiltState = await storage.db.query('SELECT * FROM routines');
  expect(after.rows).toEqual(before.rows);
  expect(rebuiltState.rows).toEqual(savedState.rows);
  expect((await state()).executionAvailable).toBe(false);
  expect(await nats.store.head()).toBe(3);
}
it('dispatches one weekly downtime range and rebuilds it without execution', weeklyDowntime);

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
  const readStreamSpy = vi.spyOn(nats.store, 'readStream');
  readStreamSpy.mockImplementation(changed);
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
  const readStreamSpy = vi.spyOn(nats.store, 'readStream');
  readStreamSpy.mockImplementation(preparation);
  const appendSpy = vi.spyOn(nats.store, 'append');
  appendSpy.mockImplementation(appendChecked);
  const headSpy = vi.spyOn(nats.store, 'head');
  headSpy.mockImplementation(accessHead);
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
  const appendSpy = vi.spyOn(nats.store, 'append');
  appendSpy.mockResolvedValueOnce(result);
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
  const performanceNowSpy = vi.spyOn(performance, 'now');
  performanceNowSpy.mockImplementation(elapsedTime);
  const read = nats.store.readStream.bind(nats.store);
  let reads = 0;
  async function* preparation(...args: Parameters<typeof read>) {
    reads += 1;
    if (reads === 2) {
      elapsed = 9100;
    }
    yield* read(...args);
  }
  const readStreamSpy = vi.spyOn(nats.store, 'readStream');
  readStreamSpy.mockImplementation(preparation);
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

async function weeklyOccupied() {
  const created = creation();
  const events = [created];
  await save(events);
  await dispatch();
  const run = (await state()).activeRun!;
  const { definition: _definition, source: _source, slot: _slot,
    firedAt: _firedAt, startBy: _startBy, ...runBinding } = run;
  const controlData = { ...runBinding, actorId: 'alice', source: 'owner',
    reason: 'owner_requested', affectedRun: run.occurrenceId, next: null };
  const stopping = { ...routine('routine.run_stop_requested'),
    principal: { kind: 'human' as const, id: 'alice' }, data: controlData };
  await save([stopping]);
  const replacement = creation('2027-04-03');
  const schedule = { ...replacement.data.definition.schedule,
    frequency: 'weekly' as const, weekday: 6 };
  const definition = { ...replacement.data.definition, schedule };
  const data = { ...replacement.data, definition, definitionRevision: 2,
    scheduleRevision: 2 };
  const edited = { ...replacement, id: 'edit', commandId: 'edit',
    type: 'routine.updated', data };
  await save([edited]);
  const before = await state();
  const position = await nats.store.head();
  now = Date.parse('2027-04-03T09:01:00.001Z');
  expect((await dispatch()).counts.late).toBe(1);
  expect(await nats.store.head()).toBe(position + 1);
  const row = await nats.store.readEvent(position + 1);
  expect(row.event.type).toBe('routine.occurrences_missed');
  const expected = { count: 1, firstLocalDate: '2027-04-03',
    lastLocalDate: '2027-04-03', next: { localDate: '2027-04-10' } };
  expect(row.event.data).toMatchObject(expected);
  const after = await state();
  expect(after.activeRun).toEqual(run);
  expect(after.activeRun?.rootId).toBe(run.rootId);
  expect(after.activation).toEqual(before.activation);
  expect(after.stopRequested).toBe(true);
  expect(after.executionAvailable).toBe(false);
}
it('records weekly downtime through dispatch while retaining the occupied run, root and Stop',
  weeklyOccupied);
