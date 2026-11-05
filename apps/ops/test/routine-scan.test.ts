import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { foldRoutine, type EventEnvelope } from '@opencrane/events';
import { calculateRoutineOccurrence } from '@opencrane/events/routine-schedule';
import { natsFixture } from '@opencrane/event-store/testing';
import { ProjectionRunner, rebuildRoutineProjection, routines } from '@opencrane/projections';
import { database } from '@opencrane/projections/testing';
import { createLogger } from '@opencrane/observability';
import { HandlerRuntime } from '@opencrane/handlers';
import * as models from '@opencrane/models';
import * as tools from '../../../libs/models/src/mcp-dispatch.ts';
import * as broker from '../../../libs/models/src/credential-broker.ts';
import { routine } from '../../../libs/authz/test/routine-fixture.ts';
import { SandboxClient } from '../src/kubernetes.ts';
import { withRoutineLeadership } from '../src/routine-leadership.ts';
import { scanRoutineCandidates } from '../src/routine-scan.ts';

let storage: Awaited<ReturnType<typeof database>>;
let nats: Awaited<ReturnType<typeof natsFixture>>;
let runner: ProjectionRunner;
let stop: AbortController;
let now: number;
let databaseUrl: string;
const logger = createLogger('routine-scan-test', { level: 'silent' });
type Continuation = Awaited<ReturnType<typeof scanRoutineCandidates>>['continuation'];

async function setup() {
  storage = await database('pg');
  const current = await storage.db.query<{ name: string }>('SELECT current_database() AS name');
  const address = new URL(process.env['PG_TEST_URL']!);
  address.pathname = `/${current.rows[0]!.name}`;
  databaseUrl = address.href;
  nats = await natsFixture();
  runner = new ProjectionRunner(storage.db, nats.reader, logger);
  await runner.initialise(routines);
  stop = new AbortController();
  now = Date.parse('2027-03-27T09:00:00.000Z');
}
async function cleanup() {
  vi.restoreAllMocks();
  await nats?.close();
  await storage?.close();
}
beforeEach(setup);
afterEach(cleanup);
function clock() {
  return now;
}
function creation(routineId: string, localDate = '2027-03-27', zone = 'UTC', localTime = '09:00') {
  const original = routine('routine.created');
  const saved = foldRoutine(undefined, original).definition!;
  const schedule = { frequency: 'daily' as const, zone, localTime };
  const calculation = { silo: 'test', routineId, scheduleRevision: 1, schedule, localDate };
  const occurrence = calculateRoutineOccurrence(calculation);
  const effectiveAt = new Date(Date.parse(occurrence.checkAt) - 1).toISOString();
  let next = null;
  if (occurrence.status === 'scheduled') {
    next = { localDate, localTime, zone, at: occurrence.at,
      offsetMinutes: occurrence.offsetMinutes };
  }
  const definition = { ...saved.definition, schedule };
  const data = { ...saved, routineId, definition, status: 'active', effectiveAt, next };
  return { ...original, id: routineId, commandId: routineId,
    subject: `routine-${routineId}`, time: effectiveAt, data };
}
async function save(events: EventEnvelope[]) {
  await nats.seed(events);
  await runner.run(routines);
}
async function scan(continuation: Continuation = null) {
  let result: Awaited<ReturnType<typeof scanRoutineCandidates>> | undefined;
  async function work(lease: Parameters<Parameters<typeof withRoutineLeadership>[1]>[0]) {
    const worker = { ...lease, silo: 'test', now: clock, continuation };
    result = await scanRoutineCandidates(storage.db, nats.store, worker);
  }
  const options = { databaseUrl, silo: 'test', signal: stop.signal };
  await withRoutineLeadership(options, work);
  return result!;
}
async function pages() {
  const events: EventEnvelope[] = [];
  for (let index = 0; index < 51; index += 1) {
    events.push(creation(`item-${String(index).padStart(2, '0')}`));
  }
  const foreign = { ...creation('foreign'), silo: 'other' };
  events.push(foreign);
  await save(events);
  const reads = vi.spyOn(nats.store, 'readStream');
  const first = await scan();
  expect(first.examined).toBe(50);
  expect(first.counts.eligible).toBe(50);
  expect(first.continuation?.afterRoutineId).toBe('item-49');
  // Move an earlier row's projection position without changing its place in the page.
  const edited = { ...creation('item-00'), id: 'edited', commandId: 'edited',
    type: 'routine.updated' };
  await save([edited]);
  const second = await scan(first.continuation);
  expect(second.examined).toBe(1);
  expect(second.continuation).toBeNull();
  const subjects: string[] = [];
  for (const call of reads.mock.calls) {
    subjects.push(call[0]);
  }
  expect(new Set(subjects).size).toBe(51);
  expect(subjects).toHaveLength(51);
  expect(subjects).not.toContain('routine-foreign');
  const repeated = await scan(first.continuation);
  expect(repeated).toEqual(second);
  await storage.reopen();
  expect(await scan(first.continuation)).toEqual(second);
  now -= 1;
  await expect(scan(first.continuation)).rejects.toThrow('Routine leadership unavailable');
  now += 1;
  await rebuildRoutineProjection(storage.db, nats.reader, logger);
  await expect(scan(first.continuation)).rejects.toThrow('Routine leadership unavailable');
}
it('crosses 51 candidates once in indexed silo order despite updated positions and restart', pages);

async function includesConcurrentInsertion() {
  const events: EventEnvelope[] = [];
  for (let index = 0; index < 51; index += 1) {
    const event = creation(`item-${String(index).padStart(2, '0')}`);
    events.push(event);
  }
  await save(events);
  const reads = vi.spyOn(nats.store, 'readStream');
  const first = await scan();
  expect(first.examined).toBe(50);
  expect(first.continuation?.afterRoutineId).toBe('item-49');
  const inserted = creation('item-00-new');
  await save([inserted]);
  const second = await scan(first.continuation);
  expect(second.examined).toBe(2);
  expect(second.counts.eligible).toBe(2);
  expect(second.continuation).toBeNull();
  const subjects: string[] = [];
  for (const call of reads.mock.calls) {
    subjects.push(call[0]);
  }
  expect(subjects.slice(50)).toEqual(['routine-item-50', 'routine-item-00-new']);
  expect(subjects).toHaveLength(52);
  expect(new Set(subjects).size).toBe(52);
}
it('includes an earlier id inserted between pages without repeating inspected routines',
  includesConcurrentInsertion);

const calendars = [
  ['Europe/Brussels', '02:30', '2027-03-28', '2027-03-28T01:00:00.000Z', 'gap'],
  ['Pacific/Apia', '00:00', '2011-12-30', '2011-12-30T10:00:00.000Z', 'gap'],
  ['Europe/Brussels', '02:30', '2026-10-25', '2026-10-25T00:31:00.000Z', 'eligible'],
  ['Europe/Brussels', '02:30', '2026-10-25', '2026-10-25T00:31:00.001Z', 'late'],
  ['UTC', '09:00', '2027-03-27', '2027-03-27T08:59:59.999Z', 'future'],
] as const;
async function calendar(zone: string, localTime: string, localDate: string,
  instant: string, category: string) {
  await save([creation('calendar', localDate, zone, localTime)]);
  now = Date.parse(instant);
  const result = await scan();
  expect(result.counts).toHaveProperty(category, 1);
  expect(result.examined).toBe(1);
  expect(result.executionAvailable).toBe(false);
}
it.each(calendars)('observes %s %s %s at %s as %s without dispatch', calendar);

async function occupiedAndInactive() {
  const created = creation('orders');
  const saved = foldRoutine(undefined, created).definition!;
  const data = { version: 1, routineId: 'orders', definitionRevision: 1,
    scheduleRevision: 1, controlRevision: 1, occurrenceId: 'occupied',
    conversationId: 'session', messageId: 'input', turnId: 'turn', rootId: 'root',
    source: 'scheduled', definition: saved.definition, slot: saved.next,
    firedAt: '2027-03-27T09:00:00.000Z', startBy: '2027-03-27T09:01:00.000Z' };
  const due = { ...created, id: 'due', commandId: 'due', type: 'routine.due', data,
    principal: { kind: 'system' as const, id: 'opencrane-server' } };
  await save([created, due]);
  expect((await scan()).counts.occupied).toBe(1);
  await save([routine('routine.paused')]);
  expect((await scan()).counts.inactive).toBe(1);
  await save([routine('routine.retired')]);
  const legacy = { ...creation('legacy'), data: { routineId: 'legacy', assistantId: 'old',
    schedule: '* * * * *', createdBy: 'alice' } };
  await save([legacy]);
  const result = await scan();
  expect(result.examined).toBe(2);
  expect(result.counts.inactive).toBe(2);
  expect(result.counts.eligible).toBe(0);
}
it('includes occupied, paused, retired and legacy rows without treating them as work',
  occupiedAndInactive);

async function changedAfterSelection(kind: string) {
  await save([creation('orders')]);
  const original = nats.store.readStream.bind(nats.store);
  async function* changed(...args: Parameters<typeof original>) {
    let change = routine('routine.paused');
    if (kind === 'edit') {
      change = { ...creation('orders', '2027-03-28'), id: 'edit', commandId: 'edit',
        type: 'routine.updated' };
    }
    await nats.seed([change]);
    yield* original(...args);
  }
  const reads = vi.spyOn(nats.store, 'readStream');
  reads.mockImplementationOnce(changed);
  const result = await scan();
  expect(result.counts.inactive + result.counts.future).toBe(1);
  expect(result.counts.eligible).toBe(0);
}
it.each(['pause', 'edit'])('reads a %s saved after selection instead of the projected definition',
  changedAfterSelection);

async function refusesLag() {
  await nats.seed([creation('orders')]);
  await expect(scan()).rejects.toThrow('Routine leadership unavailable');
  await runner.run(routines);
  expect((await scan()).examined).toBe(1);
  await storage.db.query('DELETE FROM projection_checkpoints WHERE name = $1', ['routines']);
  await expect(scan()).rejects.toThrow('Routine leadership unavailable');
}
it('refuses projection lag and a missing checkpoint instead of claiming an empty page', refusesLag);

async function refusesMissingHistory() {
  await save([creation('orders')]);
  async function* missing() {
    await Promise.resolve();
    yield* [];
  }
  const reads = vi.spyOn(nats.store, 'readStream');
  reads.mockImplementationOnce(missing);
  await expect(scan()).rejects.toThrow('Routine leadership unavailable');
}
it('refuses a selected row whose exact history is unavailable', refusesMissingHistory);

async function cancellation() {
  await save([creation('first'), creation('second')]);
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const original = nats.store.readStream.bind(nats.store);
  async function* held(...args: Parameters<typeof original>) {
    entered.resolve();
    await resume.promise;
    yield* original(...args);
  }
  const reads = vi.spyOn(nats.store, 'readStream');
  reads.mockImplementationOnce(held);
  const pending = scan();
  const rejected = expect(pending).rejects.toThrow('Routine leadership unavailable');
  await entered.promise;
  stop.abort();
  let settled = false;
  function finished() {
    settled = true;
  }
  void pending.then(finished, finished);
  await new Promise(setImmediate);
  expect(settled).toBe(false);
  resume.resolve();
  await rejected;
  expect(reads).toHaveBeenCalledTimes(1);
}
it('stops before another candidate and awaits the current history read on shutdown', cancellation);

async function backwardsTime() {
  await save([creation('orders')]);
  const original = nats.store.readStream.bind(nats.store);
  async function* backwards(...args: Parameters<typeof original>) {
    now -= 1;
    yield* original(...args);
  }
  const reads = vi.spyOn(nats.store, 'readStream');
  reads.mockImplementationOnce(backwards);
  await expect(scan()).rejects.toThrow('Routine leadership unavailable');
}
it('refuses a clock moving backwards while history is read', backwardsTime);

function forbidden(): never {
  throw new Error('Forbidden effect');
}
async function noEffects() {
  await save([creation('orders')]);
  const append = vi.spyOn(nats.store, 'append');
  const wake = vi.spyOn(SandboxClient.prototype, 'mode');
  const credentials = vi.spyOn(SandboxClient.prototype, 'credentials');
  const jobs = vi.spyOn(HandlerRuntime.prototype, 'start');
  const network = vi.spyOn(globalThis, 'fetch');
  const model = vi.spyOn(models, 'startGateway');
  const tool = vi.spyOn(tools, 'mcpDispatch');
  const credential = vi.spyOn(broker, 'credentialBroker');
  const effects = [append, wake, credentials, jobs, network, model, tool, credential];
  for (const effect of effects) {
    effect.mockImplementation(forbidden);
  }
  const before = await nats.store.head();
  expect((await scan()).counts.eligible).toBe(1);
  const options = { verify: true };
  await rebuildRoutineProjection(storage.db, nats.reader, logger, options);
  expect((await scan()).counts.eligible).toBe(1);
  expect(await nats.store.head()).toBe(before);
  for (const effect of effects) {
    expect(effect).not.toHaveBeenCalled();
  }
}
it('scans and replays without session, input, root, sender, wake, credential or network effects',
  noEffects);
