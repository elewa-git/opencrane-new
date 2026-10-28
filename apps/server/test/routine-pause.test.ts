import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createStore, memberAuthorisation } from '@opencrane/authz';
import type { AppendCommand, StoredEvent } from '@opencrane/event-store';
import { event } from '@opencrane/event-store/testing';
import { foldRoutine, getEventDefinition, type RoutineState } from '@opencrane/events';
import { openfga } from '../../../libs/authz/test/services.ts';
import { joinedMember, routine } from '../../../libs/authz/test/routine-fixture.ts';
import { database } from '../../../libs/projections/test/database.ts';
import { shortDuplicateWindowFixture, waitForDuplicateWindow }
  from './support/duplicate-window.ts';
import { pauseRoutine } from '../src/routine-pause.ts';

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
function pause(memberId = 'alice', request: unknown = input) {
  return pauseRoutine(nats.store, binding, memberId, request);
}
async function savesOnePause() {
  const before = await nats.store.head();
  const [result, concurrent] = await Promise.all([pause(), pause()]);
  expect(concurrent).toEqual(result);
  expect(result.status).toBe('confirmed');
  expect(result.changeId).toBe(input.changeId);
  expect(result.eventId).toBeTypeOf('string');
  expect(result.position).toBe(before + 1);
  expect(await pause()).toEqual(result);
  const saved = await rows();
  expect(saved).toHaveLength(2);
  expect(saved[1]?.event.data).toEqual({ version: 1, routineId: 'orders',
    definitionRevision: 1, scheduleRevision: 1, controlRevision: 2, actorId: 'alice',
    source: 'owner', reason: 'owner_requested', affectedRun: null,
    next: { localDate: '2026-10-11', localTime: '09:00', zone: 'Europe/Brussels',
      at: '2026-10-11T07:00:00Z', offsetMinutes: 120 } });
  let replayed: RoutineState | undefined;
  for (const row of saved) {
    replayed = foldRoutine(replayed, row.event);
  }
  expect(replayed?.status).toBe('paused');
  expect(replayed?.executionAvailable).toBe(false);
  expect(replayed?.activeRun).toBeNull();
  expect(await nats.store.head()).toBe(before + 1);
  expect(JSON.stringify(result)).not.toMatch(/ciphertext|key:1|instructions/u);
}
it('saves one owner pause and replays it without any execution events', savesOnePause);

async function recoversLostReply() {
  await occupy();
  const append = nats.store.append.bind(nats.store);
  async function loseReply(change: AppendCommand): Promise<never> {
    await append(change);
    throw new Error('private upstream detail');
  }
  vi.spyOn(nats.store, 'append').mockImplementationOnce(loseReply);
  await expect(pause()).rejects.toThrow('Routine pause unavailable');
  await waitForDuplicateWindow(nats);
  await nats.stop();
  await nats.restart();
  const saved = await rows();
  const result = await pause();
  expect(result.eventId).toBe(saved[2]?.event.id);
  expect(result.position).toBe(saved[2]?.sequence);
  expect(await rows()).toHaveLength(3);
}
it('recovers a lost committed reply after deduplication expires and NATS restarts',
  recoversLostReply, 30_000);

async function conflicts() {
  await pause();
  await expect(pause('bob')).rejects.toThrow('Routine pause refused');
  const changes = [ { routineId: 'other' }, { expectedDefinitionRevision: 2 },
    { expectedScheduleRevision: 2 }, { expectedControlRevision: 2 },
    { expectedPosition: 0 }, { changeId: 'orders:another-change' } ];
  for (const change of changes) {
    await expect(pause('alice', { ...input, ...change }))
      .rejects.toThrow('Routine pause conflict');
  }
  expect(await rows()).toHaveLength(2);
}
it('binds the original id to actor, target, revisions and position', conflicts);

async function rejectsReplacement() {
  for (const extra of [{ actorId: 'bob' }, { definition: {} }, { reason: 'other' }]) {
    await expect(pause('alice', { ...input, ...extra })).rejects.toThrow();
  }
  for (const member of ['admin', 'bob', 'outsider']) {
    await expect(pause(member)).rejects.toThrow('Routine pause refused');
  }
  expect(await rows()).toHaveLength(1);
}
it('refuses replacement facts, metadata-only admins and non-owners', rejectsReplacement);

async function refusesSavedChanges(type: string) {
  let saved = routine(type, 'bob');
  if (type === 'member.removed') {
    saved = event('removed-alice', 'member-alice', type);
  }

  await nats.seed([saved]);
  input.expectedPosition = await nats.store.head('routine-orders');
  input.expectedDefinitionRevision = type === 'routine.reassigned' ? 2 : 1;
  input.expectedControlRevision = type === 'routine.reassigned' ? 2 : 1;
  const before = await nats.store.head();
  await expect(pause()).rejects.toThrow('Routine pause refused');
  expect(await nats.store.head()).toBe(before);
}
it.each(['routine.reassigned', 'routine.retired', 'member.removed'])(
  'refuses saved %s even before IAM catches up', refusesSavedChanges);

async function refusesLegacy() {
  const saved = routine('routine.created');
  const legacy = { ...saved, id: 'legacy', commandId: 'legacy', subject: 'routine-old',
    data: { routineId: 'old', assistantId: 'assistant', schedule: '* * * * *',
      createdBy: 'alice' } };
  await nats.seed([legacy]);
  const request = { ...input, routineId: 'old', changeId: 'old:pause',
    expectedPosition: await nats.store.head('routine-old') };
  await expect(pause('alice', request)).rejects.toThrow('Routine pause refused');
}
it('refuses a legacy routine', refusesLegacy);

async function missingReceiptAndOutage() {
  const unprojected = routine('routine.reassigned', 'alice', 'same-owner');
  await nats.seed([unprojected]);
  input.expectedPosition = await nats.store.head('routine-orders');
  input.expectedDefinitionRevision = 2;
  input.expectedControlRevision = 2;
  await expect(pause()).rejects.toThrow('Routine pause refused');
  const auth = memberAuthorisation(binding, nats.store);
  await auth.handler.handle(unprojected, db);
  await fga.pause();
  await expect(pause()).rejects.toThrow('Routine pause refused');
  await fga.resume();
  expect(await rows()).toHaveLength(2);
}
it('requires exact IAM receipts and refuses an IAM outage', missingReceiptAndOutage, 30_000);

async function queuedChange(type: string) {
  const append = nats.store.append.bind(nats.store);
  async function changeBeforeAppend(change: AppendCommand) {
    let saved = routine('routine.reassigned', 'bob');
    if (type === 'member.removed') {
      saved = event('removed-alice', 'member-alice', type);
    }
    await nats.seed([saved]);
    return append(change);
  }
  vi.spyOn(nats.store, 'append').mockImplementationOnce(changeBeforeAppend);
  await expect(pause()).rejects.toThrow();
  const saved = await rows();
  function isPause(row: StoredEvent) {
    return row.event.type === 'routine.paused';
  }
  expect(saved.some(isPause)).toBe(false);
}
it.each(['routine.reassigned', 'member.removed'])(
  'refuses %s while the append is queued', queuedChange);

async function keepsOriginalDeadline() {
  const started = performance.now();
  const clock = vi.spyOn(performance, 'now').mockReturnValue(started);
  const append = nats.store.append.bind(nats.store);
  async function expireBeforeAppend(change: AppendCommand) {
    expect(change.checkAccess).toBeTypeOf('function');
    expect(change.historyChecked).toBe(true);
    const deadline = change.deadline!;
    expect(deadline).toBe(started + 2000);
    clock.mockReturnValue(started + 2001);
    return append(change);
  }
  vi.spyOn(nats.store, 'append').mockImplementationOnce(expireBeforeAppend);
  await expect(pause()).rejects.toThrow('Routine pause unavailable');
  vi.restoreAllMocks();
  expect(await rows()).toHaveLength(1);
}
it('keeps the original two-second deadline at append', keepsOriginalDeadline);

async function loadsHistoryFirst() {
  const read = nats.store.readStream.bind(nats.store);
  const head = nats.store.head.bind(nats.store);
  let writeStarted = false;
  const now = performance.now.bind(performance);
  let elapsed = 0;
  function delayedNow() {
    return now() + elapsed;
  }
  vi.spyOn(performance, 'now').mockImplementation(delayedNow);
  async function recordHead(subject?: string, deadline?: number) {
    writeStarted = true;
    return head(subject, deadline);
  }
  async function* recordRead(subject: string, from?: number, deadline?: number) {
    expect(writeStarted, `History read during write check: ${subject}`).toBe(false);
    yield* read(subject, from, deadline);
    elapsed += 3000;
  }
  vi.spyOn(nats.store, 'head').mockImplementation(recordHead);
  vi.spyOn(nats.store, 'readStream').mockImplementation(recordRead);
  await pause();
}
it('loads routine and member history before the short check and never reads it again',
  loadsHistoryFirst);

async function replaysSavedPause() {
  const occupied = await occupy();
  await pause();
  const storage = await database('pg');
  try {
    const current = await storage.db.query<{ name: string }>('SELECT current_database() AS name');
    const url = new URL(process.env['PG_TEST_URL']!);
    url.pathname = `/${current.rows[0]!.name}`;
    const env = { ...process.env, ...nats.env('projection'), DATABASE_URL: url.href };
    const args = ['--experimental-strip-types', '--experimental-test-module-mocks',
      '--import', './apps/ops/test/support/routine-effects.ts',
      'apps/ops/src/replay.ts', 'routines', '--confirm-routines-stopped'];
    const exec = promisify(execFile);
    const before = await nats.store.head();
    const result = await exec(process.execPath, args, { env });
    expect(result.stdout).toContain('PASS: routines');
    const saved = await storage.db.query<{ state: RoutineState }>('SELECT state FROM routines');
    expect(saved.rows[0]?.state.status).toBe('paused');
    expect(saved.rows[0]?.state.executionAvailable).toBe(false);
    const runs = await storage.db.query('SELECT * FROM routine_occurrences');
    expect(runs.rows).toHaveLength(1);
    expect(saved.rows[0]?.state.activeRun).toEqual(occupied.data);
    const jobs = await storage.db.query("SELECT tablename FROM pg_tables WHERE schemaname='pgboss'");
    expect(jobs.rows).toEqual([]);
    expect(await nats.store.head()).toBe(before);
    expect(result.stdout + result.stderr).not.toMatch(/ciphertext|key:1|Forbidden routine/u);
  } finally {
    await storage.close();
  }
}
it('rebuilds the saved pause with jobs, appends, credentials, wake and calls forbidden',
  replaysSavedPause, 30_000);

async function occupy() {
  const type = 'routine.due';
  const saved = { ...event('occupied', 'routine-orders', type), source: 'opencrane-server',
    principal: { kind: 'system' as const, id: 'opencrane-server' },
    data: getEventDefinition(type)!.example };
  await nats.seed([saved]);
  input.expectedPosition = await nats.store.head('routine-orders');
  return saved;
}
async function occupiedPause() {
  const occupied = await occupy();
  const before = await nats.store.head();
  const results = await Promise.all([pause(), pause()]);
  expect(results[0]).toEqual(results[1]);
  expect(await nats.store.head()).toBe(before + 1);
  const saved = await rows();
  expect(saved.at(-1)?.event).toMatchObject({ type: 'routine.paused',
    data: { affectedRun: 'occurrence', controlRevision: 2 } });
  let state: RoutineState | undefined;
  for (const row of saved) {
    state = foldRoutine(state, row.event);
  }
  expect(state?.activeRun).toEqual(occupied.data);
  expect(state?.executionAvailable).toBe(false);
  const changedRequests = [{ expectedPosition: 0 }, { expectedDefinitionRevision: 2 },
    { expectedScheduleRevision: 2 }, { expectedControlRevision: 2 }];
  expect(await pause()).toEqual(results[0]);
  for (const change of changedRequests) {
    await expect(pause('alice', { ...input, ...change }))
      .rejects.toThrow('Routine pause conflict');
  }
  for (const member of ['admin', 'bob', 'outsider']) {
    for (const change of [{}, { expectedPosition: 0 }, { changeId: 'orders:unknown' }]) {
      await expect(pause(member, { ...input, ...change }))
        .rejects.toThrow('Routine pause refused');
    }
  }
  expect(await nats.store.head()).toBe(before + 1);
}
it('saves one occupied pause and gives non-owners uniform refusals', occupiedPause);
