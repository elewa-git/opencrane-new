import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { createStore, grantStream, memberAuthorisation } from '@opencrane/authz';
import { natsFixture, event } from '@opencrane/event-store/testing';
import { foldRoutine, type EventEnvelope } from '@opencrane/events';
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
function clock() { return now; }
function checkCurrent() { return Promise.resolve(owned); }
function worker() {
  return { silo: 'test', binding, workerId: 'routine-worker', checkCurrent, now: clock };
}
function record(id: string, subject: string, type: string, data: unknown): EventEnvelope {
  return { ...event(id, subject, type), source: 'opencrane-server', commandId: id, data };
}
function forbidden(): never { throw new Error('private-service-canary'); }
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
