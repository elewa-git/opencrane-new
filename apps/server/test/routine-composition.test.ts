import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { generateKeyPairSync, type ECKeyPairOptions } from 'node:crypto';
import { z } from 'zod';
import { tokenIssuer } from '@opencrane/auth';
import { createStore, grantStream, memberAuthorisation } from '@opencrane/authz';
import { until } from '@opencrane/authz/testing';
import { natsFixture, event } from '@opencrane/event-store/testing';
import { foldRoutine, type EventEnvelope } from '@opencrane/events';
import { BudgetActor, history, priceTableId, rootTotals } from '@opencrane/models';
import { conversationKeys } from '@opencrane/projections';
import { openfga } from '../../../libs/authz/test/services.ts';
import { joinedMember, routine } from '../../../libs/authz/test/routine-fixture.ts';
import { bridgeChannel } from '../../computer/test/server.ts';
import { connectBridge } from '../src/chat/bridge.ts';
import * as routineSession from '../src/routine-session.ts';
import { createRoutineComposition } from '../src/routine-composition.ts';

let nats: Awaited<ReturnType<typeof natsFixture>>;
let fga: Awaited<ReturnType<typeof openfga>>;
let binding: Awaited<ReturnType<typeof createStore>>;
let keys: ReturnType<typeof conversationKeys>;
let actor: BudgetActor;
let directory: string;
let now: number;
let owned: boolean;
let preparedComputer: Awaited<ReturnType<typeof startComputer>>;
const input = { routineId: 'orders', occurrenceId: 'occurrence' };
const conversationId = 'routine-session-occurrence';
const messageId = 'routine-input-occurrence';
const turnId = 'routine-turn-occurrence';
const proposedEvent = z.object({ type: z.string() });
const frameSchema = z.record(z.string(), z.unknown());
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
  for (const saved of events) {
    await auth.handler.handle(saved, db);
  }
}
async function setup() {
  nats = await natsFixture();
  fga = await openfga();
  binding = await createStore(fga.apiUrl, 'test');
  directory = await mkdtemp('/tmp/routine-composition-');
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
    const team = { teamId: group, name: group, createdBy: 'alice' };
    const membership = { teamId: group, memberId: 'alice', addedBy: 'alice' };
    events.push(record(`created-${group}`, `team-${group}`, 'team.created', team));
    events.push(record(`added-${group}`, `team-${group}`, 'team.member_added', membership));
  }
  const assistant = { assistantId: 'sales-assistant', kind: 'team',
    ownerId: 'billing', payingGroupId: 'sales' };
  events.push(record('assistant', 'assistant-sales-assistant', 'assistant.created', assistant));
  events.push(active);
  for (const [granteeKind, granteeId] of [['member', 'alice'], ['assistant', 'sales-assistant']]) {
    const grant = { resourceType: 'model', resourceId: 'gpt-6.1-sol', granteeKind, granteeId,
      grantedBy: 'alice' };
    events.push(record(`grant-${granteeKind}`, grantStream('model', 'gpt-6.1-sol'),
      'grant.given', grant));
  }
  await apply(events);
  const due = { version: 1, routineId: 'orders', definitionRevision: 1,
    scheduleRevision: 1, controlRevision: 1, definition, occurrenceId: 'occurrence',
    conversationId, messageId, turnId, rootId: 'routine-root-occurrence', source: 'scheduled',
    slot: original.next!, firedAt: original.next!.at, startBy: '2026-10-11T07:01:00Z' };
  const claimed = record('due', 'routine-orders', 'routine.due', due);
  claimed.principal = { kind: 'system', id: 'opencrane-server' };
  await nats.seed([claimed]);
  const computer = { assistantId: 'sales-assistant', computerId: 'computer', generation: 1 };
  const ready = record('ready', 'computer-sales-assistant', 'computer.ready', computer);
  const computerClaim = { ...computer, tokenId: 'token:fixture-computer' };
  const computerClaimed = record('claimed', 'computer-sales-assistant',
    'computer.claimed', computerClaim);
  await nats.seed([computerClaimed, ready]);
  actor = new BudgetActor(nats.store, 'test');
  await actor.start(10_000, 10_000, 'sales');
  preparedComputer = await startComputer();
  const prepareSession = routineSession.prepareRoutineSession;
  async function projectSession(...supplied: Parameters<typeof prepareSession>) {
    const result = await prepareSession(...supplied);
    const rows = await history(nats.store, `conversation-${conversationId}`, 'test');
    const creation = rows[0]!.event;
    const auth = memberAuthorisation(binding, nats.store);
    const database = { query: forbidden };
    await auth.handler.handle(creation, database);
    async function applied() {
      return (await auth.checkApplied(creation.id)).allowed;
    }
    await until(applied);
    return result;
  }
  const sessionSpy = vi.spyOn(routineSession, 'prepareRoutineSession');
  sessionSpy.mockImplementation(projectSession);
}
async function startComputer() {
  const server = createServer();
  const executedThreads: string[] = [];
  const frames: Record<string, unknown>[] = [];
  let nativeStarts = 0;
  let closedSessions = 0;
  function grant() {
    return Promise.resolve();
  }
  function credential() {
    return { value: 'fixture-bridge', expiresAt: Date.now() + 120_000 };
  }
  function privateSession() {
    const lifetime = Promise.withResolvers<void>();
    let threadId: string | undefined;
    function close() {
      closedSessions++;
      lifetime.resolve();
    }
    function rpc(method: string, params: Record<string, unknown>) {
      if (method === 'thread/start') {
        nativeStarts++;
        threadId = `native-${nativeStarts}`;
        expect(params).not.toHaveProperty('threadId');
      }
      if (method === 'turn/start') {
        expect(params['threadId']).toBe(threadId);
        expect(JSON.stringify(params)).toContain('Private routine instructions');
        executedThreads.push(String(threadId));
      }
      const response = { thread: { id: threadId, ephemeral: true, path: null },
        turn: { id: 'native-turn' } };
      return Promise.resolve(response);
    }
    const session = { rpc, close, closed: lifetime.promise };
    return Promise.resolve(session);
  }
  const driver = { rpc: forbidden, grant, credential, privateSession, journal: `${directory}/journal` };
  const channel = bridgeChannel(server, driver);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Fixture unavailable');
  }
  const keyOptions: ECKeyPairOptions<'pem', 'pem'> = { namedCurve: 'P-256',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' } };
  const pair = generateKeyPairSync('ec', keyOptions);
  const fileOptions = { mode: 0o600 };
  await writeFile(`${directory}/signing.pem`, pair.privateKey, fileOptions);
  const tokenOptions = { privateKeyPath: `${directory}/signing.pem`,
    issuer: 'https://routine.test/' };
  const tokens = await tokenIssuer(tokenOptions);
  const connection = { computerId: 'computer', assistantId: 'sales-assistant',
    bearer: 'fixture-bridge', url: `ws://127.0.0.1:${address.port}/bridge` };
  const options = { silo: 'test', store: nats.store, keys, binding };
  const link = await connectBridge(options, connection, tokens);
  const send = link.socket.send.bind(link.socket);
  function track(bytes: Parameters<typeof send>[0]) {
    if (typeof bytes === 'string') {
      frames.push(frameSchema.parse(JSON.parse(bytes)));
    }
    send(bytes);
  }
  const sendSpy = vi.spyOn(link.socket, 'send');
  sendSpy.mockImplementation(track);
  function wake(assistantId: string) {
    expect(assistantId).toBe('sales-assistant');
    const ready = { link, generation: 1 };
    return Promise.resolve(ready);
  }
  async function close() {
    link.socket.terminate();
    await channel.close();
    await link.settled();
    server.close();
  }
  function executed() {
    return executedThreads.length === 1;
  }
  return { link, wake, close, executed, executedThreads, frames, send: track,
    get nativeStarts() {
      return nativeStarts;
    },
    get closedSessions() {
      return closedSessions;
    } };
}
async function cleanup() {
  vi.restoreAllMocks();
  await preparedComputer?.close();
  await fga?.close();
  await nats?.close();
  if (directory) {
    const options = { recursive: true, force: true };
    await rm(directory, options);
  }
}
beforeEach(setup);
afterEach(cleanup);

function compose(options: { enabled?: boolean; replay?: boolean } = { enabled: true }) {
  return createRoutineComposition(options, nats.store, keys, worker(), input, actor,
    'sender-attempt');
}
async function saved(type: string, subject: string) {
  const rows = await history(nats.store, subject, 'test');
  function matches(row: typeof rows[number]) {
    return row.event.type === type;
  }
  return rows.filter(matches);
}
async function assertCounts(threadId = 'native-1') {
  expect(await saved('conversation.created', `conversation-${conversationId}`)).toHaveLength(1);
  expect(await saved('message.posted', `conversation-${conversationId}`)).toHaveLength(1);
  expect(await saved('budget.root_allowance_set', 'budget-test')).toHaveLength(1);
  expect(await saved('routine.run_activation_admitted', 'routine-orders')).toHaveLength(1);
  const root = actor.state.roots[0]!;
  expect(root).toMatchObject({ payingGroupId: 'sales', allowanceCents: 1000, threadId });
  expect(rootTotals(actor.state, root.rootId)).toEqual({
    settledCents: 0, heldCents: 0, availableCents: 1000 });
  const rows = await history(nats.store, `conversation-${conversationId}`, 'test');
  expect(JSON.stringify(rows)).not.toContain('Private routine instructions');
}
async function reachesPreparedThread() {
  const invocation = compose();
  async function wake(assistantId: string) {
    advanceWake();
    return preparedComputer.wake(assistantId);
  }
  const results = await Promise.all([
    invocation.send(wake), invocation.send(wake),
  ]);
  expect(results).toContainEqual({ status: 'sent' });
  await until(preparedComputer.executed);
  expect(preparedComputer.executedThreads).toEqual(['native-1']);
  await assertCounts();
  const root = actor.state.roots[0]!;
  const call = { requesterId: 'alice', conversationId, turnId,
    assistantId: 'sales-assistant', payingGroupId: 'sales', threadId: 'native-1',
    computerId: 'computer', generation: 1, model: 'gpt-6.1-sol', priceTableId,
    contextDigest: '0'.repeat(64) };
  const hold = await actor.reserve(call, 100, undefined, undefined, root.rootId);
  await actor.uncertain(hold, 'settle_timeout');
  const before = await nats.store.head();
  await nats.stop();
  await nats.restart();
  expect(await compose().send(preparedComputer.wake)).toEqual({ status: 'unknown' });
  expect(await nats.store.head()).toBe(before);
  expect(preparedComputer.nativeStarts).toBe(1);
  expect(rootTotals(actor.state, root.rootId)).toEqual({
    settledCents: 0, heldCents: 100, availableCents: 900 });
}
it('sends one checked due to its native thread, despite duplicate invocation and restart',
  reachesPreparedThread);

async function inert(options: { enabled?: boolean; replay?: boolean }) {
  const before = await nats.store.head();
  const wake = vi.fn(forbidden);
  expect(await compose(options).send(wake)).toEqual({ status: 'unknown' });
  expect(wake).not.toHaveBeenCalled();
  expect(await nats.store.head()).toBe(before);
  expect(actor.state.roots).toEqual([]);
  expect(preparedComputer.frames).toEqual([]);
}
it.each([{}, { enabled: false }, { enabled: true, replay: true }])(
  'keeps default-disabled and replay inert: %j', inert);

const stages = ['conversation.created', 'message.posted', 'budget.root_allowance_set',
  'routine.run_activation_admitted', 'computer.turn_started'];
async function savedStageFault(stage: string, after: boolean) {
  const append = nats.store.append.bind(nats.store);
  let injected = false;
  async function failStage(...supplied: Parameters<typeof append>) {
    const proposed = proposedEvent.parse(supplied[0].event);
    const fail = !injected && proposed.type === stage;
    if (fail) {
      injected = true;
    }
    if (fail && !after) {
      forbidden();
    }
    const result = await append(...supplied);
    if (fail) {
      forbidden();
    }
    return result;
  }
  const fault = vi.spyOn(nats.store, 'append');
  fault.mockImplementation(failStage);
  await compose().send(preparedComputer.wake);
  function reachedFault() {
    return injected;
  }
  await until(reachedFault);
  await preparedComputer.link.settled();
  fault.mockRestore();
  await nats.stop();
  await nats.restart();
  actor = new BudgetActor(nats.store, 'test');
  await actor.start(10_000, 10_000, 'sales');
  const before = await nats.store.head();
  const beforeAllocation = stage === 'conversation.created' || stage === 'message.posted'
    || (stage === 'budget.root_allowance_set' && !after);
  if (beforeAllocation) {
    expect(preparedComputer.executedThreads).toEqual([]);
    expect(await saved('routine.run_activation_admitted', 'routine-orders')).toEqual([]);
    expect(await compose().send(preparedComputer.wake)).toEqual({ status: 'sent' });
    await until(preparedComputer.executed);
    expect(preparedComputer.executedThreads).toEqual(['native-2']);
    expect(preparedComputer.nativeStarts).toBe(2);
    await assertCounts('native-2');
    const recoveredPosition = await nats.store.head();
    expect(await compose().send(preparedComputer.wake)).toEqual({ status: 'unknown' });
    expect(await nats.store.head()).toBe(recoveredPosition);
    expect(preparedComputer.executedThreads).toEqual(['native-2']);
    expect(preparedComputer.nativeStarts).toBe(2);
  } else {
    expect(await compose().send(preparedComputer.wake)).toEqual({ status: 'unknown' });
    expect(await nats.store.head()).toBe(before);
    expect(preparedComputer.executedThreads).toEqual([]);
  }
  expect(actor.state.roots.length).toBeLessThanOrEqual(1);
  expect(actor.state.reservations).toEqual([]);
  for (const type of stages) {
    let subject = `conversation-${conversationId}`;
    if (type === 'budget.root_allowance_set') {
      subject = 'budget-test';
    }
    if (type === 'routine.run_activation_admitted') {
      subject = 'routine-orders';
    }
    if (type === 'computer.turn_started') {
      subject = 'computer-sales-assistant';
    }
    expect((await saved(type, subject)).length).toBeLessThanOrEqual(1);
  }
}
for (const stage of stages) {
  const checkStageFault = savedStageFault.bind(undefined, stage);
  it.each([false, true])(`recovers only before allocation after ${stage} fault, saved=%s`,
    checkStageFault);
}

async function change(kind: string) {
  if (kind === 'worker') {
    owned = false;
  } else if (kind === 'pause') {
    await nats.seed([routine('routine.paused')]);
  } else {
    const removal = { memberId: 'alice', removedBy: 'admin' };
    const removed = record('removed', 'member-alice', 'member.removed', removal);
    await nats.seed([removed]);
  }
}
function advanceWake() {
  const monotonic = performance.now.bind(performance);
  function afterWake() {
    return monotonic() + 14_000;
  }
  now += 14_000;
  const clockSpy = vi.spyOn(performance, 'now');
  clockSpy.mockImplementation(afterWake);
}
async function refusesChangedAccess(kind: string, late: boolean) {
  const append = nats.store.append.bind(nats.store);
  let injected = false;
  async function afterStart(...supplied: Parameters<typeof append>) {
    const result = await append(...supplied);
    const proposed = proposedEvent.parse(supplied[0].event);
    if (proposed.type === 'computer.turn_started' && !injected) {
      injected = true;
      await change(kind);
    }
    return result;
  }
  async function wake(assistantId: string) {
    if (!late) {
      advanceWake();
      await change(kind);
    }
    return preparedComputer.wake(assistantId);
  }
  if (late) {
    const appendSpy = vi.spyOn(nats.store, 'append');
    appendSpy.mockImplementation(afterStart);
  }
  await compose().send(wake);
  if (late) {
    function refused() {
      return preparedComputer.closedSessions > 0;
    }
    await until(refused);
    expect(injected).toBe(true);
  }
  expect(preparedComputer.executedThreads).toEqual([]);
  function executable(frame: Record<string, unknown>) {
    return frame['type'] === 'ack' && typeof frame['token'] === 'string';
  }
  expect(preparedComputer.frames.filter(executable)).toEqual([]);
  expect(preparedComputer.link.socket.readyState).toBe(preparedComputer.link.socket.OPEN);
}
for (const kind of ['member', 'pause', 'worker']) {
  const checkChangedAccess = refusesChangedAccess.bind(undefined, kind);
  it.each([false, true])(`refuses ${kind} loss during wake or after saved start, late=%s`,
    checkChangedAccess);
}

async function lostSendReply() {
  const socket = preparedComputer.link.socket;
  const send = preparedComputer.send;
  function loseReply(bytes: Parameters<typeof send>[0]) {
    send(bytes);
    if (typeof bytes === 'string' && frameSchema.parse(JSON.parse(bytes))['type'] === 'turn') {
      forbidden();
    }
  }
  const sendSpy = vi.spyOn(socket, 'send');
  sendSpy.mockImplementation(loseReply);
  expect(await compose().send(preparedComputer.wake)).toEqual({ status: 'unknown' });
  function refused() {
    return preparedComputer.closedSessions === 1;
  }
  await until(refused);
  await preparedComputer.link.settled();
  expect(await compose().send(preparedComputer.wake)).toEqual({ status: 'unknown' });
  await assertCounts();
  expect(preparedComputer.executedThreads).toEqual([]);
}
it('never repeats a send whose transport reply was lost', lostSendReply);

async function refusesPreparation(kind: string) {
  const link = preparedComputer.link;
  if (kind === 'missing') {
    const prepareSpy = vi.spyOn(link, 'prepareRoutineThread');
    const error = new Error('private-native-canary');
    prepareSpy.mockRejectedValue(error);
  } else if (kind === 'thread') {
    const prepare = link.prepareRoutineThread;
    async function wrongThread(...supplied: Parameters<typeof prepare>) {
      await prepare(...supplied);
      return 'not-the-native-thread';
    }
    const prepareSpy = vi.spyOn(link, 'prepareRoutineThread');
    prepareSpy.mockImplementation(wrongThread);
  }
  async function wake(assistantId: string) {
    const ready = await preparedComputer.wake(assistantId);
    if (kind === 'computer') {
      return { ...ready, link: { ...link, computerId: 'wrong-computer' } };
    }
    return ready;
  }
  await compose().send(wake);
  if (kind === 'thread') {
    function refused() {
      return preparedComputer.closedSessions > 0;
    }
    await until(refused);
  }
  expect(preparedComputer.executedThreads).toEqual([]);
  expect(link.socket.readyState).toBe(link.socket.OPEN);
}
it.each(['missing', 'computer', 'thread'])('refuses %s preparation without closing the bridge',
  refusesPreparation);

async function anotherThread() {
  const append = nats.store.append.bind(nats.store);
  let injected = false;
  async function startOther(...supplied: Parameters<typeof append>) {
    const proposed = proposedEvent.parse(supplied[0].event);
    if (proposed.type === 'computer.turn_started' && !injected) {
      injected = true;
      const other = { assistantId: 'sales-assistant', computerId: 'computer',
        conversationId: 'other', turnId: 'other-turn', threadId: 'other-thread',
        requesterId: 'alice', task: 'chat_turn', executionMode: 'restricted' };
      await nats.seed([record('other-start', 'computer-sales-assistant',
        'computer.turn_started', other)]);
    }
    return append(...supplied);
  }
  const appendSpy = vi.spyOn(nats.store, 'append');
  appendSpy.mockImplementation(startOther);
  expect(await compose().send(preparedComputer.wake)).toEqual({ status: 'sent' });
  await until(preparedComputer.executed);
  expect(injected).toBe(true);
  await assertCounts();
}
it('allows another thread to start during the checked computer append', anotherThread);

async function refusesBeforeWake() {
  owned = false;
  const options = { enabled: true };
  await inert(options);
}
it('checks worker ownership before allowing wake', refusesBeforeWake);
