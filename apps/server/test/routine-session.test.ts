import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import { createStore, memberAuthorisation } from '@opencrane/authz';
import { createEventStore, type AppendCommand, type StoredEvent } from '@opencrane/event-store';
import { event } from '@opencrane/event-store/testing';
import { foldRoutine, getEventDefinition, type EventEnvelope } from '@opencrane/events';
import { conversationKeys } from '@opencrane/projections';
import { openfga } from '../../../libs/authz/test/services.ts';
import { joinedMember, routine } from '../../../libs/authz/test/routine-fixture.ts';
import { TupleClient, objectId } from '../../../libs/authz/src/client.ts';
import { database } from '../../../libs/projections/test/database.ts';
import { shortDuplicateWindowFixture, waitForDuplicateWindow }
  from './support/duplicate-window.ts';
import { calculateRoutineOccurrence } from '@opencrane/events/routine-schedule';
import { claimRoutineDue } from '../../ops/src/routine-due.ts';
import { chatCommand, chatHistory } from '../src/chat/commands.ts';
import { prepareRoutineSession } from '../src/routine-session.ts';

let nats: Awaited<ReturnType<typeof shortDuplicateWindowFixture>>;
let fga: Awaited<ReturnType<typeof openfga>>;
let binding: Awaited<ReturnType<typeof createStore>>;
let keys: ReturnType<typeof conversationKeys>;
let directory: string;
let now: number;
let owned: boolean;
let duringCheck: (() => Promise<void>) | undefined;
let encryption: ReturnType<typeof vi.spyOn>;
let decryption: ReturnType<typeof vi.spyOn>;
const input = { routineId: 'orders', occurrenceId: 'occurrence' };
const conversationId = 'routine-session-occurrence';
const commandId = 'routine-session-create-occurrence';
const subject = `conversation-${conversationId}`;
function clock() {
  return now;
}
async function checkCurrent() {
  const action = duringCheck;
  duringCheck = undefined;
  await action?.();
  return owned;
}
function forbiddenEffect(): never {
  throw new Error('private-service-canary');
}
const db = { query: forbiddenEffect };
function record(id: string, subject: string, type: string, data: unknown): EventEnvelope {
  return { ...event(id, subject, type), source: 'opencrane-server', commandId: id, data };
}
async function apply(events: EventEnvelope[]) {
  await nats.seed(events);
  const auth = memberAuthorisation(binding, nats.store);
  for (const saved of events) {
    await auth.handler.handle(saved, db);
  }
}
function definition() {
  return foldRoutine(undefined, routine('routine.created')).definition!;
}
function due() {
  const saved = definition();
  const data = { ...saved, occurrenceId: input.occurrenceId, conversationId,
    messageId: 'routine-input-occurrence', turnId: 'routine-turn-occurrence',
    rootId: 'routine-root-occurrence', source: 'scheduled', slot: saved.next!,
    firedAt: saved.next!.at, startBy: '2026-10-11T07:01:00Z' };
  const { status: _status, actorId: _actor, effectiveAt: _effective, next: _next,
    cursor: _cursor, ...run } = data;
  const savedDue = record('due', 'routine-orders', 'routine.due', run);
  return { ...savedDue, principal: { kind: 'system' as const, id: 'opencrane-server' } };
}
async function setup() {
  nats = await shortDuplicateWindowFixture();
  fga = await openfga();
  binding = await createStore(fga.apiUrl, 'test');
  directory = await mkdtemp('/tmp/routine-session-');
  keys = conversationKeys(directory);
  now = Date.parse('2026-10-11T07:00:00Z');
  owned = true;
  duringCheck = undefined;
  const created = routine('routine.created');
  const active = { ...created, data: { ...definition(), status: 'active' } };
  const events = [joinedMember('alice')];
  for (const group of ['sales', 'billing']) {
    events.push(record(`created-${group}`, `team-${group}`, 'team.created',
      { teamId: group, name: group, createdBy: 'alice' }));
    events.push(record(`added-${group}`, `team-${group}`, 'team.member_added',
      { teamId: group, memberId: 'alice', addedBy: 'alice' }));
  }
  events.push(record('assistant', 'assistant-sales-assistant', 'assistant.created',
    { assistantId: 'sales-assistant', kind: 'team', ownerId: 'billing', payingGroupId: 'sales' }));
  events.push(active);
  await apply(events);
  await nats.seed([due()]);
  encryption = vi.spyOn(keys, 'encrypt').mockImplementation(forbiddenEffect);
  decryption = vi.spyOn(keys, 'decrypt').mockImplementation(forbiddenEffect);
}
async function cleanup() {
  vi.restoreAllMocks();
  await fga?.close();
  await nats?.close();
  if (directory) {
    await rm(directory, { recursive: true, force: true });
  }
}
beforeEach(setup, 30_000);
afterEach(cleanup);
function prepare(store = nats.store, request: unknown = input, workerId = 'routine-worker') {
  const worker = { silo: 'test', binding, workerId, checkCurrent, now: clock };
  return prepareRoutineSession(store, keys, worker, request);
}
async function rows() {
  const saved: StoredEvent[] = [];
  for await (const row of nats.store.readStream(subject)) {
    saved.push(row);
  }
  return saved;
}
async function refuses() {
  const before = await nats.store.head();
  await expect(prepare()).rejects.toThrow('Routine session refused');
  expect(await nats.store.head()).toBe(before);
}
async function createsOnce() {
  const before = await nats.store.head();
  const fetch = globalThis.fetch;
  function permissionsOnly(url: Parameters<typeof fetch>[0], options?: RequestInit) {
    const address = url instanceof Request ? url.url : url.toString();
    if (!address.startsWith(binding.apiUrl + '/')) {
      return forbiddenEffect();
    }
    return fetch(url, options);
  }
  vi.spyOn(globalThis, 'fetch').mockImplementation(permissionsOnly);
  const [first, second] = await Promise.all([prepare(), prepare()]);
  expect(first).toEqual(second);
  expect(first).toEqual({ status: 'confirmed', occurrenceId: input.occurrenceId,
    conversationId, eventId: commandId, position: before + 1,
    startBy: '2026-10-11T07:01:00Z', executionAvailable: false });
  expect(await prepare()).toEqual(first);
  const saved = await rows();
  expect(saved).toHaveLength(1);
  expect(saved[0]!.event.data).toEqual({ conversationId, assistantId: 'sales-assistant',
    createdBy: 'alice', mode: 'agent_session', payingGroupId: 'sales',
    routinePreparation: { routineId: 'orders', occurrenceId: 'occurrence',
      claimId: 'due', claimPosition: before, workerId: 'routine-worker' } });
  expect(await nats.store.head()).toBe(before + 1);
  expect(encryption).not.toHaveBeenCalled();
  expect(decryption).not.toHaveBeenCalled();
  expect(JSON.stringify(first)).not.toMatch(/ciphertext|key:1|instructions|private-service/u);
}
it('two workers recover one private session with zero input or execution effects', createsOnce);

async function recovers() {
  const append = nats.store.append.bind(nats.store);
  async function lostReply(change: AppendCommand): Promise<never> {
    await append(change);
    return forbiddenEffect();
  }
  vi.spyOn(nats.store, 'append').mockImplementationOnce(lostReply);
  await expect(prepare()).rejects.toThrow('Routine session refused');
  const first = await prepare();
  await waitForDuplicateWindow(nats);
  await nats.stop();
  await nats.restart();
  const connection = await nats.client('command');
  const restarted = await createEventStore(connection);
  const before = await restarted.head();
  expect(await prepare(restarted)).toEqual(first);
  expect(await restarted.head()).toBe(before);
  expect(await rows()).toHaveLength(1);
}
it('recovers after a lost reply, restart and expired transport deduplication', recovers);

async function refusesOrdinaryChatBeforeClaim() {
  const saved = definition();
  const routineId = 'future-orders';
  const created = routine('routine.created', 'alice', 'future-created');
  const data = { ...saved, routineId, status: 'active' };
  const future = { ...created, subject: `routine-${routineId}`, data };
  await apply([future]);
  const expectedPosition = await nats.store.head(future.subject);
  const calculation = { silo: 'test', routineId, scheduleRevision: 1,
    schedule: saved.definition.schedule, localDate: saved.next!.localDate };
  const occurrence = calculateRoutineOccurrence(calculation);
  const futureConversationId = `routine-session-${occurrence.occurrenceId}`;
  const context = { silo: 'test', memberId: 'alice' };
  const create = { id: `routine-session-create-${occurrence.occurrenceId}`,
    conversationId: futureConversationId, assistantId: 'sales-assistant',
    mode: 'agent_session', payingGroupId: 'sales' };
  keys.provision('test', futureConversationId);
  expect((await chatCommand(nats.store, keys, context, create)).status).toBe('appended');
  encryption.mockRestore();
  decryption.mockRestore();
  const message = { id: 'human-before-claim', conversationId: futureConversationId,
    text: 'Earlier human instructions must never enter a routine session' };
  expect((await chatCommand(nats.store, keys, context, message)).status).toBe('appended');
  const beforeHistory = await chatHistory(nats.store, 'test', futureConversationId);
  expect(beforeHistory).toHaveLength(2);
  expect(beforeHistory[1]!.event.type).toBe('message.posted');
  const worker = { silo: 'test', binding, checkCurrent, now: clock };
  const request = { routineId, expectedPosition, localDate: saved.next!.localDate,
    definitionRevision: 1, scheduleRevision: 1, controlRevision: 1 };
  const claim = await claimRoutineDue(nats.store, worker, request);
  expect(claim.status).toBe('confirmed');
  const before = await nats.store.head();
  const preparation = { routineId, occurrenceId: claim.occurrenceId };
  await expect(prepare(nats.store, preparation)).rejects.toThrow('Routine session refused');
  expect(await nats.store.head()).toBe(before);
  expect(await chatHistory(nats.store, 'test', futureConversationId)).toEqual(beforeHistory);
}
it('refuses an ordinary chat and human message saved before a genuine claim',
  refusesOrdinaryChatBeforeClaim);

async function recoversBoundPreparation() {
  const first = await prepare();
  const before = await nats.store.head();
  const saved = await rows();
  expect(saved[0]!.event.data).toMatchObject({ routinePreparation: {
    routineId: 'orders', occurrenceId: 'occurrence', claimId: 'due',
    workerId: 'routine-worker', claimPosition: before - 1,
  } });
  expect(await prepare()).toEqual(first);
  await expect(prepare(nats.store, input, 'other-worker'))
    .rejects.toThrow('Routine session refused');
  expect(await nats.store.head()).toBe(before);
  expect(await rows()).toEqual(saved);
}
it('returns the saved session only for the same worker and claim', recoversBoundPreparation);

async function reusedBinding(field: string) {
  const data = { conversationId, assistantId: 'sales-assistant', createdBy: 'alice',
    mode: 'agent_session', payingGroupId: 'sales', [field]: 'someone-else' };
  const saved = record(commandId, subject, 'conversation.created', data);
  saved.principal = { kind: 'human', id: 'alice' };
  await nats.seed([saved]);
  await refuses();
}
it.each(['createdBy', 'assistantId', 'payingGroupId'])('refuses a reused id with changed %s',
  reusedBinding);

async function removeMember() {
  const removed = record('removed', 'member-alice', 'member.removed',
    { memberId: 'alice', removedBy: 'admin' });
  await apply([removed]);
}
async function losesAccess(kind: string) {
  if (kind === 'removed' || kind === 'rejoined') {
    await removeMember();
    if (kind === 'rejoined') {
      const joined = { ...joinedMember('alice'), id: 'joined-again', commandId: 'joined-again' };
      await apply([joined]);
    }
  } else if (kind === 'worker') {
    owned = false;
  } else if (kind === 'manage' || kind === 'acts_for') {
    const client = new TupleClient(binding);
    let tuple = { user: objectId('person', 'test', 'alice'), relation: 'owner',
      object: objectId('routine', 'test', 'orders') };
    if (kind === 'acts_for') {
      tuple = { user: `${objectId('team', 'test', 'billing')}#member`, relation: 'acts_for',
        object: objectId('assistant', 'test', 'sales-assistant') };
    }
    await client.write([], [tuple]);
  } else {
    const group = kind === 'payer' ? 'sales' : 'billing';
    const removed = record('removed-group', `team-${group}`, 'team.member_removed',
      { teamId: group, memberId: 'alice', removedBy: 'alice' });
    await apply([removed]);
  }
  await refuses();
}
const lostAccess = ['removed', 'rejoined', 'worker', 'manage', 'acts_for', 'team', 'payer'];
it.each(lostAccess)('refuses new preparation after losing %s', losesAccess);
async function losesReceiptAccess(kind: string) {
  await prepare();
  await losesAccess(kind);
}
it.each(lostAccess)('withholds saved identifiers after losing %s', losesReceiptAccess);

async function control(type: string) {
  const example = getEventDefinition(type)!.example;
  const base = typeof example === 'object' && example !== null ? example : {};
  let data: Record<string, unknown> = { ...base, conversationId, messageId: 'routine-input-occurrence',
    turnId: 'routine-turn-occurrence', rootId: 'routine-root-occurrence' };
  if (type === 'routine.updated') {
    data = { ...definition(), status: 'active', definitionRevision: 2 };
  } else if (['routine.paused', 'routine.retired', 'routine.reassigned'].includes(type)) {
    data = { ...base, controlRevision: 2 };
  }
  const saved = record(type, 'routine-orders', type, data);
  saved.principal = { kind: 'human', id: 'alice' };
  await nats.seed([saved]);
}
const controls = ['routine.paused', 'routine.retired', 'routine.reassigned',
  'routine.run_stop_requested', 'routine.updated'];
async function changedControl(type: string) {
  await control(type);
  await refuses();
}
it.each(controls)('refuses preparation after %s', changedControl);
async function changesAtAppend(kind: string) {
  const append = nats.store.append.bind(nats.store);
  async function changeBeforeAppend(change: AppendCommand) {
    expect(change.checkAccess).toBeTypeOf('function');
    if (kind === 'member') {
      await removeMember();
    } else if (kind === 'worker') {
      owned = false;
    } else if (kind === 'expiry') {
      now += 60_000;
    } else {
      await control(kind);
    }
    return append(change);
  }
  vi.spyOn(nats.store, 'append').mockImplementationOnce(changeBeforeAppend);
  await expect(prepare()).rejects.toThrow('Routine session refused');
  expect(await rows()).toEqual([]);
}
it.each([...controls, 'member', 'worker', 'expiry'])('rechecks %s at append', changesAtAppend);
async function changesAfterAppend(kind: string) {
  const append = nats.store.append.bind(nats.store);
  async function changeAfterAppend(change: AppendCommand) {
    const result = await append(change);
    if (kind === 'worker') {
      owned = false;
    } else if (kind === 'expiry') {
      now += 60_000;
    } else {
      await removeMember();
    }
    return result;
  }
  vi.spyOn(nats.store, 'append').mockImplementationOnce(changeAfterAppend);
  await expect(prepare()).rejects.toThrow('Routine session refused');
  expect(await rows()).toHaveLength(1);
}
it.each(['member', 'worker', 'expiry'])('checks %s before returning identifiers', changesAfterAppend);
async function expires() {
  const first = await prepare();
  now = Date.parse(first.startBy);
  await refuses();
  expect(await rows()).toHaveLength(1);
}
it('old receipts cannot extend startBy or authorise preparation', expires);

async function historyFirst() {
  await prepare();
  const read = nats.store.readStream.bind(nats.store);
  const head = nats.store.head.bind(nats.store);
  const originalNow = performance.now.bind(performance);
  let elapsed = 0;
  let accessStarted = false;
  function delayedClock() {
    return originalNow() + elapsed;
  }
  async function recordHead(target?: string, deadline?: number) {
    if (target === undefined) {
      accessStarted = true;
    }
    expect(target).not.toBe(subject);
    expect(target).not.toBe('routine-orders');
    return head(target, deadline);
  }
  async function* delayedRead(target: string, from = 1, deadline?: number) {
    if ((target === subject || target === 'routine-orders') && from === 1) {
      expect(accessStarted).toBe(false);
      elapsed += 3000;
    }
    yield* read(target, from, deadline);
  }
  vi.spyOn(performance, 'now').mockImplementation(delayedClock);
  vi.spyOn(nats.store, 'head').mockImplementation(recordHead);
  vi.spyOn(nats.store, 'readStream').mockImplementation(delayedRead);
  expect((await prepare()).executionAvailable).toBe(false);
}
it('loads long histories before access and never watches growing streams', historyFirst);
async function masksHistory(failedSubject: string) {
  owned = false;
  const read = nats.store.readStream.bind(nats.store);
  async function* unavailable(target: string, from?: number, deadline?: number) {
    if (target === failedSubject) {
      forbiddenEffect();
    }
    yield* read(target, from, deadline);
  }
  vi.spyOn(nats.store, 'readStream').mockImplementation(unavailable);
  await refuses();
}
it.each(['routine-orders', subject])('masks private %s history errors', masksHistory);
async function expiredWrite() {
  const append = nats.store.append.bind(nats.store);
  async function expire(change: AppendCommand) {
    vi.spyOn(performance, 'now').mockReturnValue(change.deadline! + 1);
    return append(change);
  }
  vi.spyOn(nats.store, 'append').mockImplementationOnce(expire);
  await expect(prepare()).rejects.toThrow('Routine session refused');
  vi.restoreAllMocks();
  expect(await rows()).toEqual([]);
}
it('keeps the original two-second deadline at publication', expiredWrite);
async function unrelatedActivity() {
  const original = await prepare();
  async function addActivity() {
    const data = { conversationId, turnId: 'unrelated', assistantId: 'sales-assistant' };
    const activity = record('activity', subject, 'agent.turn_started', data);
    await nats.seed([activity]);
  }
  duringCheck = addActivity;
  expect(await prepare()).toEqual(original);
}
it('unrelated conversation activity preserves receipt access', unrelatedActivity);
async function changedAssistant(kind: string) {
  if (kind === 'inactive') {
    const changed = record('inactive', 'assistant-sales-assistant', 'assistant.settings_changed',
      { assistantId: 'sales-assistant', changedBy: 'alice', changedFields: ['active'], active: false });
    await nats.seed([changed]);
  } else {
    const read = nats.store.readStream.bind(nats.store);
    async function* changedPayer(target: string, from?: number, deadline?: number) {
      for await (const row of read(target, from, deadline)) {
        if (row.event.type === 'assistant.created') {
          const data = { assistantId: 'sales-assistant', kind: 'team', ownerId: 'billing',
            payingGroupId: 'billing' };
          yield { ...row, event: { ...row.event, data } };
        } else {
          yield row;
        }
      }
    }
    vi.spyOn(nats.store, 'readStream').mockImplementation(changedPayer);
  }
  await refuses();
}
it.each(['inactive', 'payer'])('refuses an assistant with changed %s', changedAssistant);
async function suppliedDefinition() {
  const request = { ...input, definition: definition().definition };
  await expect(prepare(nats.store, request)).rejects.toThrow('Routine session refused');
  expect(await rows()).toEqual([]);
}
it('refuses a supplied definition', suppliedDefinition);
async function replay() {
  await prepare();
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
    expect(result.stdout + result.stderr).not.toMatch(/private-service|ciphertext|key:1|Forbidden/u);
    expect(await nats.store.head()).toBe(before);
    const jobs = await storage.db.query("SELECT tablename FROM pg_tables WHERE schemaname='pgboss'");
    expect(jobs.rows).toEqual([]);
  } finally {
    await storage.close();
  }
}
it('replays with appends, jobs, wake, credentials, tokens and external calls forbidden', replay,
  30_000);
