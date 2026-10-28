import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createStore, memberAuthorisation, rebuildMembers } from '@opencrane/authz';
import type { AppendCommand, StoredEvent } from '@opencrane/event-store';
import { event, failingPublishStore } from '@opencrane/event-store/testing';
import { foldRoutine, getEventDefinition, type RoutineState } from '@opencrane/events';
import { openfga } from '../../../libs/authz/test/services.ts';
import { joinedMember, routine } from '../../../libs/authz/test/routine-fixture.ts';
import { database } from '../../../libs/projections/test/database.ts';
import { shortDuplicateWindowFixture, waitForDuplicateWindow }
  from './support/duplicate-window.ts';
import { retireRoutine } from '../src/routine-retire.ts';

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
  input = { changeId: 'orders:retire-1', routineId: 'orders',
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
function retire(memberId = 'alice', request: unknown = input) {
  return retireRoutine(nats.store, binding, memberId, request);
}
async function savesOneRetirement(status: string) {
  if (status === 'paused') {
    const paused = routine('routine.paused');
    await nats.seed([paused]);
    input.expectedPosition = await nats.store.head('routine-orders');
    input.expectedControlRevision = 2;
  }
  const before = await nats.store.head();
  const [result, concurrent] = await Promise.all([retire(), retire()]);
  expect(concurrent).toEqual(result);
  expect(result.status).toBe('confirmed');
  expect(result.changeId).toBe(input.changeId);
  expect(result.eventId).toBeTypeOf('string');
  expect(result.position).toBe(before + 1);
  await applyRetirement();
  expect(await retire()).toEqual(result);
  const saved = await rows();
  expect(saved).toHaveLength(status === 'paused' ? 3 : 2);
  expect(saved.at(-1)?.event.data).toEqual({ version: 1, routineId: 'orders',
    definitionRevision: 1, scheduleRevision: 1,
    controlRevision: input.expectedControlRevision + 1, actorId: 'alice',
    source: 'owner', reason: 'owner_requested', affectedRun: null,
    next: null });
  let replayed: RoutineState | undefined;
  for (const row of saved) {
    replayed = foldRoutine(replayed, row.event);
  }
  expect(replayed?.status).toBe('retired');
  expect(replayed?.executionAvailable).toBe(false);
  expect(replayed?.activeRun).toBeNull();
  expect(await nats.store.head()).toBe(before + 1);
  expect(JSON.stringify(result)).not.toMatch(/ciphertext|key:1|instructions/u);
}
it.each(['active', 'paused'])(
  'retires an %s routine once without any execution events', savesOneRetirement);

async function recoversLostReply() {
  await occupy();
  const append = nats.store.append.bind(nats.store);
  async function loseReply(change: AppendCommand): Promise<never> {
    await append(change);
    throw new Error('private upstream detail');
  }
  vi.spyOn(nats.store, 'append').mockImplementationOnce(loseReply);
  await expect(retire()).rejects.toThrow('Routine retirement unavailable');
  await waitForDuplicateWindow(nats);
  await nats.stop();
  await nats.restart();
  const saved = await rows();
  await applyRetirement();
  const result = await retire();
  expect(result.eventId).toBe(saved[2]?.event.id);
  expect(result.position).toBe(saved[2]?.sequence);
  expect(await rows()).toHaveLength(3);
}
it('recovers a lost committed reply after deduplication expires and NATS restarts',
  recoversLostReply, 30_000);

async function conflicts() {
  await retire();
  await applyRetirement();
  await expect(retire('bob')).rejects.toThrow(new Error('Routine retirement refused'));
  await expect(retire('admin')).rejects.toThrow(new Error('Routine retirement refused'));
  const changes = [ { routineId: 'other' }, { expectedDefinitionRevision: 2 },
    { expectedScheduleRevision: 2 }, { expectedControlRevision: 2 },
    { expectedPosition: 0 } ];
  for (const change of changes) {
    await expect(retire('alice', { ...input, ...change }))
      .rejects.toThrow('Routine retirement conflict');
  }
  const newChange = { ...input, changeId: 'orders:another-change',
    expectedPosition: await nats.store.head('routine-orders'), expectedControlRevision: 2 };
  await expect(retire('alice', newChange)).rejects.toThrow('Routine retirement refused');
  expect(await rows()).toHaveLength(2);
}
it('binds the original id to actor, target, revisions and position', conflicts);

const unreadableCases = [
  ['bob', 'active'],
  ['bob', 'retired'],
  ['removed owner', 'active'],
  ['removed owner', 'retired'],
];

async function hidesUnreadableHistory(caller: string, status: string) {
  if (status === 'retired') {
    await retire();
    await applyRetirement();
  }
  let memberId = caller;
  if (caller === 'removed owner') {
    memberId = 'alice';
    const removed = event('removed-alice', 'member-alice', 'member.removed');
    await nats.seed([removed]);
  }
  const auth = memberAuthorisation(binding, nats.store);
  const access = await auth.routine(memberId, input.routineId, 'read_metadata');
  expect(access.allowed).toBe(false);
  const before = await nats.store.head();
  const savedBefore = await rows();
  const append = vi.spyOn(nats.store, 'append');
  const revisions = [
    {},
    { expectedDefinitionRevision: 2 },
    { expectedScheduleRevision: 2 },
    { expectedControlRevision: 2 },
    { expectedPosition: 0 },
  ];
  const changeIds = [input.changeId, 'orders:unknown-change'];
  for (const changeId of changeIds) {
    for (const revision of revisions) {
      const request = { ...input, ...revision, changeId };
      await expect.soft(retire(memberId, request))
        .rejects.toThrow(new Error('Routine retirement refused'));
    }
  }
  expect(append).not.toHaveBeenCalled();
  expect(await rows()).toEqual(savedBefore);
  expect(await nats.store.head()).toBe(before);
}
it.each(unreadableCases)(
  'gives %s the same refusal and no receipt for an unreadable %s routine',
  hidesUnreadableHistory);

async function rejectsReplacement() {
  for (const extra of [{ actorId: 'bob' }, { definition: {} }, { reason: 'other' }]) {
    await expect(retire('alice', { ...input, ...extra })).rejects.toThrow();
  }
  for (const member of ['admin', 'bob', 'outsider']) {
    await expect(retire(member)).rejects.toThrow('Routine retirement refused');
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
  await expect(retire()).rejects.toThrow('Routine retirement refused');
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
  const request = { ...input, routineId: 'old', changeId: 'old:retire',
    expectedPosition: await nats.store.head('routine-old') };
  await expect(retire('alice', request)).rejects.toThrow('Routine retirement refused');
}
it('refuses a legacy routine', refusesLegacy);

async function missingReceiptAndOutage() {
  const unprojected = routine('routine.reassigned', 'alice', 'same-owner');
  await nats.seed([unprojected]);
  input.expectedPosition = await nats.store.head('routine-orders');
  input.expectedDefinitionRevision = 2;
  input.expectedControlRevision = 2;
  await expect(retire()).rejects.toThrow('Routine retirement refused');
  const auth = memberAuthorisation(binding, nats.store);
  await auth.handler.handle(unprojected, db);
  await fga.pause();
  await expect(retire()).rejects.toThrow('Routine retirement refused');
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
  await expect(retire()).rejects.toThrow();
  const saved = await rows();
  function isRetirement(row: StoredEvent) {
    return row.event.type === 'routine.retired';
  }
  expect(saved.some(isRetirement)).toBe(false);
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
  await expect(retire()).rejects.toThrow('Routine retirement unavailable');
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
  await retire();
}
it('loads routine and member history before the short check and never reads it again',
  loadsHistoryFirst);

async function replaysSavedRetirement() {
  await retire();
  await applyRetirement();
  const options = { verifyAgainst: binding };
  const rebuilt = await rebuildMembers(fga.apiUrl, 'test', nats.reader, options);
  expect(rebuilt.verified).toBe(true);
  const auth = memberAuthorisation(rebuilt.binding, nats.store);
  for (const member of ['alice', 'admin']) {
    expect((await auth.routine(member, 'orders', 'read_metadata')).allowed).toBe(true);
    expect((await auth.routine(member, 'orders', 'manage')).allowed).toBe(false);
  }
  expect((await auth.routine('bob', 'orders', 'read_metadata')).allowed).toBe(false);
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
    expect(saved.rows[0]?.state.status).toBe('retired');
    expect(saved.rows[0]?.state.executionAvailable).toBe(false);
    expect(saved.rows[0]?.state.definition?.next).toBeNull();
    const runs = await storage.db.query('SELECT * FROM routine_occurrences');
    expect(runs.rows).toEqual([]);
    const jobs = await storage.db.query("SELECT tablename FROM pg_tables WHERE schemaname='pgboss'");
    expect(jobs.rows).toEqual([]);
    expect(await nats.store.head()).toBe(before);
    expect(result.stdout + result.stderr).not.toMatch(/ciphertext|key:1|Forbidden routine/u);
  } finally {
    await storage.close();
  }
}
it('rebuilds the saved retirement with jobs, appends, credentials, wake and calls forbidden',
  replaysSavedRetirement, 30_000);

async function applyRetirement() {
  const saved = await rows();
  const auth = memberAuthorisation(binding, nats.store);
  await auth.handler.handle(saved.at(-1)!.event, db);
  expect((await auth.routine('alice', 'orders', 'manage')).allowed).toBe(false);
}

async function refusesRecoveryWithoutAccess(condition: string) {
  await retire();
  if (condition !== 'missing receipt') {
    await applyRetirement();
  }
  if (condition === 'removed') {
    const removed = event('removed-alice', 'member-alice', 'member.removed');
    await nats.seed([removed]);
  }
  if (condition === 'outage') {
    await fga.pause();
  }
  const append = vi.spyOn(nats.store, 'append');
  await expect(retire()).rejects.toThrow('Routine retirement refused');
  expect(append).not.toHaveBeenCalled();
  if (condition === 'outage') {
    await fga.resume();
  }
}
it.each(['missing receipt', 'removed', 'outage'])(
  'refuses committed recovery with %s', refusesRecoveryWithoutAccess, 30_000);

async function changesDuringPublishRetry(condition: string) {
  const retry = await failingPublishStore(nats.connection);
  const started = performance.now();
  const clock = vi.spyOn(performance, 'now').mockReturnValue(started);
  async function changeBeforeRetry() {
    if (condition === 'expiry') {
      clock.mockReturnValue(started + 2001);
    } else {
      let changed = routine('routine.reassigned', 'bob');
      if (condition === 'removal') {
        changed = event('removed-alice', 'member-alice', 'member.removed');
      }
      await nats.seed([changed]);
    }
  }
  retry.failNextPublish(changeBeforeRetry);
  await expect(retireRoutine(retry.store, binding, 'alice', input)).rejects.toThrow();
  expect(retry.publishAttempts()).toBe(condition === 'reassignment' ? 2 : 1);
  vi.restoreAllMocks();
  const saved = await rows();
  function isRetirement(row: StoredEvent) {
    return row.event.type === 'routine.retired';
  }
  expect(saved.some(isRetirement)).toBe(false);
}
it.each(['reassignment', 'removal', 'expiry'])(
  'refuses %s during publish retry', changesDuringPublishRetry);

async function saveMalformedPrincipal() {
  const saved = routine('routine.retired');
  const data = { version: 1, routineId: 'orders', definitionRevision: 1,
    scheduleRevision: 1, controlRevision: 2, actorId: 'alice', source: 'owner',
    reason: 'owner_requested', affectedRun: null, next: null };
  const mismatched = { ...saved, commandId: input.changeId, data };
  await nats.seed([mismatched]);
}

async function refusesMalformedPrincipal(memberId: string) {
  const auth = memberAuthorisation(binding, nats.store);
  expect((await auth.routine(memberId, 'orders', 'read_metadata')).allowed).toBe(true);
  await saveMalformedPrincipal();
  const before = await nats.store.head();
  const append = vi.spyOn(nats.store, 'append');
  await expect(retire(memberId)).rejects.toThrow(new Error('Routine retirement unavailable'));
  expect(append).not.toHaveBeenCalled();
  expect(await nats.store.head()).toBe(before);
}
it.each(['alice', 'admin'])(
  'reports a saved principal mismatch as unavailable to permitted reader %s',
  refusesMalformedPrincipal);

async function hidesMalformedPrincipal(condition: string) {
  let memberId = condition;
  if (condition === 'removed owner') {
    memberId = 'alice';
    const removed = event('removed-alice', 'member-alice', 'member.removed');
    await nats.seed([removed]);
  }
  if (condition === 'IAM outage') {
    memberId = 'admin';
    await fga.pause();
  }
  await saveMalformedPrincipal();
  const before = await nats.store.head();
  const append = vi.spyOn(nats.store, 'append');
  const missing = { ...input, routineId: 'missing', changeId: 'missing:retire' };
  try {
    await expect(retire(memberId, missing))
      .rejects.toThrow(new Error('Routine retirement refused'));
    await expect(retire(memberId)).rejects.toThrow(new Error('Routine retirement refused'));
    expect(append).not.toHaveBeenCalled();
    expect(await nats.store.head()).toBe(before);
  } finally {
    if (condition === 'IAM outage') {
      await fga.resume();
    }
  }
}
it.each(['bob', 'outsider', 'removed owner', 'IAM outage'])(
  'hides a saved principal mismatch with the missing-routine refusal for %s',
  hidesMalformedPrincipal);

async function occupy() {
  const type = 'routine.due';
  const saved = { ...event('occupied', 'routine-orders', type), source: 'opencrane-server',
    principal: { kind: 'system' as const, id: 'opencrane-server' },
    data: getEventDefinition(type)!.example };
  await nats.seed([saved]);
  input.expectedPosition = await nats.store.head('routine-orders');
  return saved;
}
async function occupiedRetirement() {
  const occupied = await occupy();
  const before = await nats.store.head();
  const results = await Promise.all([retire(), retire()]);
  expect(results[0]).toEqual(results[1]);
  expect(await nats.store.head()).toBe(before + 1);
  const saved = await rows();
  expect(saved.at(-1)?.event).toMatchObject({ type: 'routine.retired',
    data: { affectedRun: 'occurrence', controlRevision: 2 } });
  let state: RoutineState | undefined;
  for (const row of saved) {
    state = foldRoutine(state, row.event);
  }
  expect(state?.activeRun).toEqual(occupied.data);
  expect(state?.executionAvailable).toBe(false);
  for (const member of ['admin', 'bob', 'outsider']) {
    for (const change of [{}, { expectedPosition: 0 }, { changeId: 'orders:unknown' }]) {
      await expect(retire(member, { ...input, ...change }))
        .rejects.toThrow('Routine retirement refused');
    }
  }
  expect(await nats.store.head()).toBe(before + 1);
}
it('saves one occupied retire and gives non-owners uniform refusals', occupiedRetirement);
