import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createEventStore } from '@opencrane/event-store';
import { createStore, memberAuthorisation, type Binding } from '@opencrane/authz';
import { foldRoutine, type EventEnvelope, type RoutineState } from '@opencrane/events';
import { calculateRoutineOccurrence } from '@opencrane/events/routine-schedule';
import { ProjectionRunner, rebuildRoutineProjection, routines } from '@opencrane/projections';
import { database } from '@opencrane/projections/testing';
import { createLogger } from '@opencrane/observability';
import { event } from '@opencrane/event-store/testing';
import { openfga } from '../../../libs/authz/test/services.ts';
import { routine, joinedMember } from '../../../libs/authz/test/routine-fixture.ts';
import { shortDuplicateWindowFixture, waitForDuplicateWindow }
  from '../../server/test/support/duplicate-window.ts';
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
}
async function cleanup() {
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
    await auth.handler.handle(saved, storage.db);
  }
  await runner.run(routines);
}
async function dispatch(continuation: Progress['continuation'] = null) {
  let result: Progress | undefined;
  async function work(lease: Lease) {
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
