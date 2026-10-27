import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { createStore, grantStream, memberAuthorisation } from '@opencrane/authz';
import { natsFixture, event } from '@opencrane/event-store/testing';
import { foldRoutine, routineActivationSchema, type EventEnvelope } from '@opencrane/events';
import { BudgetActor, history, priceTableId, rootTotals } from '@opencrane/models';
import { conversationKeys } from '@opencrane/projections';
import { openfga } from '../../../libs/authz/test/services.ts';
import { joinedMember, routine } from '../../../libs/authz/test/routine-fixture.ts';
import { prepareRoutineSession } from '../src/routine-session.ts';
import { prepareRoutineInput } from '../src/routine-input.ts';
import { allocateRoutineRoot } from '../src/routine-root.ts';
import { admitRoutineActivation } from '../src/routine-activation.ts';
import { inspectRoutineSender } from '../src/routine-sender.ts';

let nats: Awaited<ReturnType<typeof natsFixture>>;
let fga: Awaited<ReturnType<typeof openfga>>;
let binding: Awaited<ReturnType<typeof createStore>>;
let keys: ReturnType<typeof conversationKeys>;
let actor: BudgetActor;
let directory: string;
let now: number;
let owned: boolean;
const input = { routineId: 'orders', occurrenceId: 'occurrence' };
const selection = { threadId: 'prepared-thread', computerId: 'computer', generation: 1 };
const conversationId = 'routine-session-occurrence';
const messageId = 'routine-input-occurrence';
const turnId = 'routine-turn-occurrence';
function clock() {
  return now;
}
function checkCurrent() {
  return Promise.resolve(owned);
}
function worker() {
  return { silo: 'test', binding, workerId: 'routine-worker', checkCurrent, now: clock };
}
function record(id: string, subject: string, type: string, data: unknown): EventEnvelope {
  return { ...event(id, subject, type), source: 'opencrane-server', commandId: id, data };
}
function forbidden(): never {
  throw new Error('private-service-canary');
}
async function apply(events: EventEnvelope[]) {
  await nats.seed(events);
  const auth = memberAuthorisation(binding, nats.store);
  const db = { query: forbidden };
  for (const saved of events) await auth.handler.handle(saved, db);
}
async function setup() {
  nats = await natsFixture();
  fga = await openfga();
  binding = await createStore(fga.apiUrl, 'test');
  directory = await mkdtemp('/tmp/routine-sender-');
  keys = conversationKeys(directory);
  keys.provision('test', 'routine-orders');
  now = Date.parse('2026-10-11T07:00:00Z');
  owned = true;
  const created = routine('routine.created');
  const original = foldRoutine(undefined, created).definition!;
  const instructions = keys.encrypt('test', 'routine-orders', 'Private routine instructions');
  const definition = { ...original.definition, instructions };
  const active = { ...created, data: { ...original, definition, status: 'active' } };
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
  for (const [granteeKind, granteeId] of [['member', 'alice'], ['assistant', 'sales-assistant']]) {
    events.push(record(`grant-${granteeKind}`, grantStream('model', 'gpt-6.1-sol'), 'grant.given',
      { resourceType: 'model', resourceId: 'gpt-6.1-sol', granteeKind, granteeId,
        grantedBy: 'alice' }));
  }
  await apply(events);
  const due = { version: 1, routineId: 'orders', definitionRevision: 1,
    scheduleRevision: 1, controlRevision: 1, definition, occurrenceId: 'occurrence',
    conversationId, messageId, turnId, rootId: 'routine-root-occurrence', source: 'scheduled',
    slot: original.next!, firedAt: original.next!.at, startBy: '2026-10-11T07:01:00Z' };
  const claimed = record('due', 'routine-orders', 'routine.due', due);
  claimed.principal = { kind: 'system', id: 'opencrane-server' };
  await nats.seed([claimed]);
  await prepareRoutineSession(nats.store, keys, worker(), input);
  const rows = await history(nats.store, `conversation-${conversationId}`, 'test');
  const auth = memberAuthorisation(binding, nats.store);
  await auth.handler.handle(rows[0]!.event, { query: forbidden });
  await prepareRoutineInput(nats.store, keys, worker(), input);
  const ready = record('ready', 'computer-sales-assistant', 'computer.ready',
    { assistantId: 'sales-assistant', computerId: 'computer', generation: 1 });
  await nats.seed([ready]);
  actor = new BudgetActor(nats.store, 'test');
  await actor.start(10_000, 10_000, 'sales');
  await allocateRoutineRoot(nats.store, keys, worker(), input, actor, selection);
}
async function cleanup() {
  vi.restoreAllMocks();
  await fga?.close();
  await nats?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
}
beforeEach(setup);
afterEach(cleanup);
function admit() {
  return admitRoutineActivation(nats.store, keys, worker(), input, selection, 'sender-attempt');
}
function inspect(senderAttemptId = 'sender-attempt') {
  return inspectRoutineSender(nats.store, keys, worker(), input, selection, senderAttemptId);
}
async function noAdmission() {
  const before = await nats.store.head();
  await expect(inspect()).rejects.toThrow('Routine sender unavailable');
  expect(await nats.store.head()).toBe(before);
}
it('missing admission cannot create an admission or a sender attempt', noAdmission);

async function exactAdmission() {
  const admission = await admit();
  const before = await nats.store.head();
  const results = await Promise.all([inspect(), inspect()]);
  const expected = { status: 'unknown', occurrenceId: 'occurrence', conversationId,
    messageId, turnId, rootId: actor.state.roots[0]!.rootId, senderAttemptId: 'sender-attempt',
    admission: { eventId: admission.eventId, position: admission.position },
    executionAvailable: false };
  expect(results).toEqual([expected, expected]);
  expect(await inspect()).toEqual(expected);
  expect(await nats.store.head()).toBe(before);
  expect(actor.state.roots).toHaveLength(1);
  expect(actor.state.reservations).toEqual([]);
  expect(JSON.stringify(results)).not.toMatch(/Private|ciphertext|keyId|private-service/u);
}
it('duplicate inspections preserve distinct input and turn ids without inferring unsent',
  exactAdmission);

async function rejectsOtherAttempt() {
  await admit();
  const before = await nats.store.head();
  await expect(inspect('another-attempt')).rejects.toThrow('Routine sender unavailable');
  expect(await nats.store.head()).toBe(before);
}
it('a different sender attempt cannot adopt the admission', rejectsOtherAttempt);

async function lostReply() {
  const append = nats.store.append.bind(nats.store);
  async function loseReply(...args: Parameters<typeof append>) {
    await append(...args);
    return forbidden();
  }
  vi.spyOn(nats.store, 'append').mockImplementationOnce(loseReply);
  await expect(admit()).rejects.toThrow('Routine activation refused');
  const before = await nats.store.head();
  const result = await inspect();
  await nats.stop();
  await nats.restart();
  expect(await inspect()).toEqual(result);
  expect(result.status).toBe('unknown');
  expect(await nats.store.head()).toBe(before);
}
it('a lost admission reply and restart do not grant permission to redeliver', lostReply);

async function changes(kind: string) {
  if (kind === 'expiry') {
    now += 60_000;
  } else if (kind === 'worker') {
    owned = false;
  } else if (kind === 'member') {
    await nats.seed([record('removed', 'member-alice', 'member.removed',
      { memberId: 'alice', removedBy: 'admin' })]);
  } else if (kind === 'grant') {
    await nats.seed([record('revoked', grantStream('model', 'gpt-6.1-sol'), 'grant.revoked',
      { resourceType: 'model', resourceId: 'gpt-6.1-sol', granteeKind: 'member',
        granteeId: 'alice', revokedBy: 'admin' })]);
  } else if (kind === 'computer') {
    await nats.seed([record('replacement', 'computer-sales-assistant', 'computer.ready',
      { assistantId: 'sales-assistant', computerId: 'computer', generation: 2 })]);
  } else {
    await nats.seed([routine(kind)]);
  }
}
async function delayedAccessChange(kind: string) {
  await admit();
  // Model preparation time without sleeping or starting a computer.
  now += 14_000;
  await changes(kind);
  const before = await nats.store.head();
  await expect(inspect()).rejects.toThrow('Routine sender unavailable');
  expect(await nats.store.head()).toBe(before);
}
it.each(['member', 'grant', 'worker', 'expiry', 'computer', 'routine.paused', 'routine.retired'])(
  'checks current %s after a fourteen-second preparation wait', delayedAccessChange);

async function alteredAdmission(field: string) {
  await admit();
  const read = nats.store.readStream.bind(nats.store);
  async function* altered(...args: Parameters<typeof read>) {
    for await (const row of read(...args)) {
      if (row.event.type !== 'routine.run_activation_admitted') {
        yield row;
        continue;
      }
      const data = routineActivationSchema.parse(row.event.data);
      yield { ...row, event: { ...row.event, data: { ...data, [field]: 'changed' } } };
    }
  }
  vi.spyOn(nats.store, 'readStream').mockImplementation(altered);
  await expect(inspect()).rejects.toThrow('Routine sender unavailable');
}
it.each(['messageId', 'turnId', 'rootId', 'senderAttemptId'])(
  'refuses a saved admission with another %s', alteredAdmission);

async function retainsUncertainHold() {
  await admit();
  const root = actor.state.roots[0]!;
  const call = { requesterId: 'alice', conversationId, turnId,
    assistantId: 'sales-assistant', payingGroupId: 'sales', ...selection,
    model: 'gpt-6.1-sol', priceTableId, contextDigest: '0'.repeat(64) };
  const hold = await actor.reserve(call, 100, undefined, undefined, root.rootId);
  await actor.uncertain(hold, 'settle_timeout');
  const before = await nats.store.head();
  expect(await inspect()).toMatchObject({ status: 'unknown', rootId: root.rootId });
  expect(rootTotals(actor.state, root.rootId)).toEqual({
    settledCents: 0, heldCents: 100, availableCents: 900 });
  expect(await nats.store.head()).toBe(before);
}
it('inspection preserves the integer-cent allowance and uncertain hold', retainsUncertainHold);

async function historyBeforeAccess() {
  await admit();
  const read = nats.store.readStream.bind(nats.store);
  const head = nats.store.head.bind(nats.store);
  const originalNow = performance.now.bind(performance);
  let elapsed = 0;
  let accessStarted = false;
  function delayedClock() {
    return originalNow() + elapsed;
  }
  async function recordHead(target?: string, deadline?: number) {
    if (target === undefined) accessStarted = true;
    expect(target).not.toBe(`conversation-${conversationId}`);
    expect(target).not.toBe('routine-orders');
    return head(target, deadline);
  }
  async function* delayedRead(target: string, from = 1, deadline?: number) {
    if ((target === `conversation-${conversationId}` || target === 'routine-orders') && from === 1) {
      expect(accessStarted).toBe(false);
      elapsed += 3000;
    }
    yield* read(target, from, deadline);
  }
  vi.spyOn(performance, 'now').mockImplementation(delayedClock);
  vi.spyOn(nats.store, 'head').mockImplementation(recordHead);
  vi.spyOn(nats.store, 'readStream').mockImplementation(delayedRead);
  expect(await inspect()).toMatchObject({ status: 'unknown', executionAvailable: false });
  expect(elapsed).toBeGreaterThanOrEqual(6000);
}
it('reads growing histories before fresh access without watching the conversation',
  historyBeforeAccess);

async function unrelatedTraffic() {
  await admit();
  const head = nats.store.head.bind(nats.store);
  let count = 0;
  async function appendActivity(target?: string, deadline?: number) {
    count++;
    const activity = record(`activity-${count}`, 'conversation-other', 'agent.turn_started',
      { conversationId: 'other', turnId: `other-turn-${count}`, assistantId: 'sales-assistant' });
    await nats.seed([activity]);
    return head(target, deadline);
  }
  vi.spyOn(nats.store, 'head').mockImplementation(appendActivity);
  expect(await inspect()).toMatchObject({ status: 'unknown', executionAvailable: false });
  expect(count).toBeGreaterThan(1);
}
it('sustained unrelated activity does not prevent inspection', unrelatedTraffic);
