import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { generateKeyPairSync } from 'node:crypto';
import { tokenIssuer } from '@opencrane/auth';
import { until } from '@opencrane/authz/testing';
import { bridgeChannel } from '../../computer/test/server.ts';
import { connectBridge } from '../src/chat/bridge.ts';
import { assistantProcessor } from '../src/chat/bridge-poll.ts';
import { createLogger } from '@opencrane/observability';
import { pauseRoutine } from '../src/routine-pause.ts';
import { retireRoutine } from '../src/routine-retire.ts';
import { requestRoutineStop } from '../src/routine-stop.ts';
import { createRoutineSender } from '../src/routine-sender.ts';
import { createStore, grantStream, memberAuthorisation } from '@opencrane/authz';
import { natsFixture, event } from '@opencrane/event-store/testing';
import { foldRoutine, routineActivationSchema, type EventEnvelope } from '@opencrane/events';
import { BudgetActor, history, priceTableId, rootTotals } from '@opencrane/models';
import { conversationKeys } from '@opencrane/projections';
import { openfga } from '../../../libs/authz/test/services.ts';
import { joinedMember, routine } from '../../../libs/authz/test/routine-fixture.ts';
import { prepareRoutineComputer } from '../src/routine-computer.ts';
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
let preparedComputer: Awaited<ReturnType<typeof startComputer>>;
const proposedEvent = z.object({ type: z.string() });
const frameSchema = z.record(z.string(), z.unknown());
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
  const ready = record('ready', 'computer-sales-assistant', 'computer.ready',
    { assistantId: 'sales-assistant', computerId: 'computer', generation: 1 });
  await nats.seed([record('claimed', 'computer-sales-assistant', 'computer.claimed',
    { assistantId: 'sales-assistant', computerId: 'computer', generation: 1,
      tokenId: 'token:fixture-computer' }), ready]);
  actor = new BudgetActor(nats.store, 'test');
  await actor.start(10_000, 10_000, 'sales');
  preparedComputer = await startComputer();
  const append = nats.store.append.bind(nats.store);
  async function projectCreation(...args: Parameters<typeof append>) {
    const result = await append(...args);
    if (proposedEvent.parse(args[0].event).type === 'conversation.created') {
      expect(preparedComputer.nativeStarts).toBe(1);
      const rows = await history(nats.store, `conversation-${conversationId}`, 'test');
      const auth = memberAuthorisation(binding, nats.store);
      await auth.handler.handle(rows[0]!.event, { query: forbidden });
    }
    return result;
  }
  const projection = vi.spyOn(nats.store, 'append');
  projection.mockImplementation(projectCreation);
  const link = await preparedComputer.wake();
  const preparedSelection = await prepareRoutineComputer(nats.store, keys, worker(),
    input, actor, link, 1);
  Object.assign(selection, preparedSelection);
  projection.mockRestore();
}
async function cleanup() {
  vi.restoreAllMocks();
  await preparedComputer?.close();
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


function sender(enabled = true, replay = false) {
  return createRoutineSender({ enabled, replay }, nats.store, keys, worker(), input,
    selection, 'sender-attempt');
}
async function recordingComputer(computerId = 'computer') {
  if (computerId === 'computer') return preparedComputer;
  return startComputer(computerId);
}
async function startComputer(computerId = 'computer') {
  const server = createServer();
  let starts = 0;
  let sends = 0;
  let nativeStarts = 0;
  const faults = { failRemoval: false, delayStart: false, stallInterrupt: false };
  const startReply = Promise.withResolvers<void>();
  const interruptReply = Promise.withResolvers<void>();
  function grant(_thread: string, _conversation: string, token: string) {
    if (!token && faults.failRemoval) {
      faults.failRemoval = false;
      return Promise.reject(new Error('private-cleanup-canary'));
    }
    return Promise.resolve();
  }
  function credential() {
    return { value: 'fixture-bridge', expiresAt: Date.now() + 120_000 };
  }
  const executedThreads: string[] = [];
  const interruptedThreads: string[] = [];
  const closedThreads: string[] = [];
  let closedSessions = 0;
  function privateSession() {
    const lifetime = Promise.withResolvers<void>();
    let threadId: string | undefined;
    let closed = false;
    function close() {
      if (!closed) {
        closedSessions++;
        if (threadId) closedThreads.push(threadId);
      }
      closed = true;
      lifetime.resolve();
    }
    async function rpc(method: string, params: Record<string, unknown>) {
      if (method === 'thread/start') {
        expect(params).not.toHaveProperty('threadId');
        expect(JSON.stringify(params)).not.toContain('Private routine instructions');
        nativeStarts++;
        threadId = `native-thread-${nativeStarts}`;
      }
      if (method === 'turn/interrupt') {
        interruptedThreads.push(String(params['threadId']));
        if (faults.stallInterrupt) await interruptReply.promise;
      }
      if (method === 'turn/start') {
        expect(closed).toBe(false);
        expect(params['threadId']).toBe(threadId);
        expect(JSON.stringify(params)).toContain('Private routine instructions');
        executedThreads.push(String(threadId));
        starts++;
        if (faults.delayStart) await startReply.promise;
      }
      return Promise.resolve({ thread: { id: threadId, ephemeral: true, path: null },
        turn: { id: 'recorded-turn' } });
    }
    const session = { rpc, close, closed: lifetime.promise };
    return Promise.resolve(session);
  }
  const driver = { rpc: forbidden, grant, credential, privateSession, journal: `${directory}/journal` };
  let channel = bridgeChannel(server, driver);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture unavailable');
  const pair = generateKeyPairSync('ec', { namedCurve: 'P-256',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' } });
  await writeFile(`${directory}/signing.pem`, pair.privateKey, { mode: 0o600 });
  const tokens = await tokenIssuer({ privateKeyPath: `${directory}/signing.pem`,
    issuer: 'https://routine.test/' });
  const connection = { computerId, assistantId: 'sales-assistant',
    bearer: 'fixture-bridge', url: `ws://127.0.0.1:${address.port}/bridge` };
  const options = { silo: 'test', store: nats.store, keys, binding };
  let link = await connectBridge(options, connection, tokens);
  function trackFrames() {
    const send = link.socket.send.bind(link.socket);
    function tracked(bytes: Parameters<typeof send>[0]) {
      if (typeof bytes === 'string') {
        const frame = frameSchema.parse(JSON.parse(bytes));
        if (frame['type'] === 'turn') sends++;
      }
      send(bytes);
    }
    vi.spyOn(link.socket, 'send').mockImplementation(tracked);
  }
  trackFrames();
  function wake() {
    return Promise.resolve(link);
  }
  async function restart() {
    link.socket.terminate();
    await link.settled();
    await channel.close();
    channel = bridgeChannel(server, driver);
    link = await connectBridge(options, connection, tokens);
    trackFrames();
  }
  function finish(threadId: string, nativeTurnId = 'recorded-turn') {
    channel.notification({ method: 'turn/completed', params: {
      threadId, turn: { id: nativeTurnId, status: 'completed' } } });
  }
  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    startReply.resolve();
    interruptReply.resolve();
    link.socket.terminate();
    await channel.close();
    await link.settled();
    server.close();
  }
  function executed() {
    if (link.socket.readyState === link.socket.CLOSED) {
      throw new Error(`Recording bridge closed: ${link.rejection ?? 'unavailable'}`);
    }
    return starts === 1;
  }
  return { wake, restart, close, executed, get starts() { return starts; },
    get sends() { return sends; }, get nativeStarts() { return nativeStarts; },
    get closedSessions() { return closedSessions; }, executedThreads, interruptedThreads, closedThreads, tokens, faults,
    releaseStart: startReply.resolve, finish };
}
async function savedStarts() {
  const rows = await history(nats.store, 'computer-sales-assistant', 'test');
  function started(row: typeof rows[number]) {
    return row.event.type === 'computer.turn_started';
  }
  return rows.filter(started);
}
async function handsOffOnce() {
  const authority = sender();
  const computer = await recordingComputer();
  const root = actor.state.roots[0]!;
  const call = { requesterId: 'alice', conversationId, turnId,
    assistantId: 'sales-assistant', payingGroupId: 'sales', ...selection,
    model: 'gpt-6.1-sol', priceTableId, contextDigest: '0'.repeat(64) };
  const hold = await actor.reserve(call, 100, undefined, undefined, root.rootId);
  await actor.uncertain(hold, 'settle_timeout');
  const budgetPosition = await nats.store.head('budget-test');
  const head = nats.store.head.bind(nats.store);
  let activity = 0;
  let startAppends = 0;
  let conflicted = false;
  const append = nats.store.append.bind(nats.store);
  async function trackStart(...args: Parameters<typeof append>) {
    const proposed = proposedEvent.parse(args[0].event);
    if (proposed.type === 'computer.turn_started') startAppends++;
    return append(...args);
  }
  vi.spyOn(nats.store, 'append').mockImplementation(trackStart);
  async function unrelated(target?: string, deadline?: number) {
    // Keep traffic flowing through preparation, then force one publication conflict.
    if (startAppends > 0 && (target === undefined || conflicted)) return head(target, deadline);
    if (startAppends > 0) conflicted = true;
    activity++;
    await nats.seed([record(`busy-${activity}`, 'conversation-other', 'agent.turn_started',
      { conversationId: 'other', turnId: `other-${activity}`, assistantId: 'sales-assistant' })]);
    return head(target, deadline);
  }
  async function wake() {
    advanceWake();
    vi.spyOn(nats.store, 'head').mockImplementation(unrelated);
    return computer.wake();
  }
  try {
    const results = await Promise.all([authority.send(wake), sender().send(wake)]);
    expect(results).toContainEqual({ status: 'sent' });
    await until(computer.executed);
    const starts = await savedStarts();
    expect(starts).toHaveLength(1);
    expect(starts[0]!.event.data).toMatchObject({ turnId, messageId,
      rootId: actor.state.roots[0]!.rootId, threadId: selection.threadId });
    expect(await readFile(`${directory}/journal.executions`, 'utf8')).toBe(`${turnId}\n`);
    expect(await authority.send(computer.wake)).toEqual({ status: 'unknown' });
    await computer.restart();
    expect(await sender().send(computer.wake)).toEqual({ status: 'unknown' });
    expect(computer.starts).toBe(1);
    expect(computer.nativeStarts).toBe(1);
    expect(computer.sends).toBe(1);
    expect(await savedStarts()).toHaveLength(1);
    expect(actor.state.roots).toHaveLength(1);
    expect(activity).toBeGreaterThan(2);
    expect(startAppends).toBe(2);
    expect(await nats.store.head('budget-test')).toBe(budgetPosition);
    expect(rootTotals(actor.state, root.rootId)).toEqual({
      settledCents: 0, heldCents: 100, availableCents: 900 });
    const rows = await history(nats.store, `conversation-${conversationId}`, 'test');
    expect(JSON.stringify(rows)).not.toContain('Private routine instructions');
    function isInput(row: typeof rows[number]) {
      return row.event.type === 'message.posted';
    }
    expect(rows.filter(isInput)).toHaveLength(1);
  } finally { await computer.close(); }
}
it('hands an admitted routine to the real bridge and journal once with distinct ids', handsOffOnce);

function advanceWake() {
  const monotonic = performance.now.bind(performance);
  function afterWake() {
    return monotonic() + 14_000;
  }
  now += 14_000;
  vi.spyOn(performance, 'now').mockImplementation(afterWake);
}
async function refusesAfterWake(kind: string) {
  const authority = sender();
  const computer = await recordingComputer();
  let wakes = 0;
  async function wake() {
    wakes++;
    advanceWake();
    if (kind === 'Stop') {
      const root = actor.state.roots[0]!;
      const subject = `conversation-${conversationId}`;
      await nats.seed([record('stop', subject, 'agent.turn_stop_requested',
        { conversationId, turnId, requestedBy: 'alice' })]);
      const position = await nats.store.head(subject);
      await actor.stopRoot(root.rootId, 'requester_stop', subject, position);
    } else if (kind === 'owner Stop') {
      const request = { ...input, changeId: 'orders:stop-1',
        expectedPosition: await nats.store.head('routine-orders'),
        expectedDefinitionRevision: 1, expectedScheduleRevision: 1, expectedControlRevision: 1 };
      await requestRoutineStop(nats.store, binding, 'alice', request);
    } else if (kind === 'owner Pause' || kind === 'owner Retire') {
      const request = { routineId: 'orders', changeId: 'orders:control-1',
        expectedPosition: await nats.store.head('routine-orders'),
        expectedDefinitionRevision: 1, expectedScheduleRevision: 1, expectedControlRevision: 1 };
      const command = kind === 'owner Pause' ? pauseRoutine : retireRoutine;
      await command(nats.store, binding, 'alice', request);
      expect(actor.state.roots[0]!.stop).toBeUndefined();
    } else {
      await changes(kind);
    }
    return computer.wake();
  }
  try {
    expect(await authority.send(wake)).toEqual({ status: 'unknown' });
    expect(wakes).toBe(1);
    expect(computer.sends).toBe(0);
    expect(computer.starts).toBe(0);
    expect(await savedStarts()).toEqual([]);
    expect(await authority.send(computer.wake)).toEqual({ status: 'unknown' });
  } finally { await computer.close(); }
}
it.each(['member', 'grant', 'expiry', 'routine.paused', 'computer', 'Stop', 'owner Stop',
  'owner Pause', 'owner Retire'])(
  'sends nothing after fourteen-second wake and %s', refusesAfterWake);

async function inert(enabled: boolean, replay: boolean) {
  const before = await nats.store.head();
  const wake = vi.fn(forbidden);
  const authority = enabled ? sender(enabled, replay)
    : createRoutineSender({}, nats.store, keys, worker(), input, selection, 'sender-attempt');
  expect(await authority.send(wake)).toEqual({ status: 'unknown' });
  expect(wake).not.toHaveBeenCalled();
  expect(await nats.store.head()).toBe(before);
}
it.each([[false, false], [true, true]])('does not wake or send enabled=%s replay=%s', inert);

async function losesReply(stage: string) {
  const authority = sender();
  const computer = await recordingComputer();
  const append = nats.store.append.bind(nats.store);
  let lost = false;
  async function loseStart(...args: Parameters<typeof append>) {
    const result = await append(...args);
    const proposed = proposedEvent.parse(args[0].event);
    if (!lost && proposed.type === stage) {
      expect(result.status).toBe('appended');
      lost = true;
      forbidden();
    }
    return result;
  }
  async function wake() {
    const link = await computer.wake();
    if (stage === 'send') {
      const send = link.socket.send.bind(link.socket);
      function loseSend(bytes: Parameters<typeof send>[0]) {
        send(bytes);
        lost = true;
        forbidden();
      }
      vi.spyOn(link.socket, 'send').mockImplementationOnce(loseSend);
    }
    return link;
  }
  vi.spyOn(nats.store, 'append').mockImplementation(loseStart);
  try {
    await authority.send(wake);
    function replyLost() {
      return lost;
    }
    await until(replyLost);
    if (stage === 'send') await until(computer.executed);
    expect(await authority.send(computer.wake)).toEqual({ status: 'unknown' });
    await computer.restart();
    expect(await sender().send(computer.wake)).toEqual({ status: 'unknown' });
    expect(computer.starts).toBeLessThanOrEqual(1);
    expect(computer.sends).toBe(stage === 'routine.run_activation_admitted' ? 0 : 1);
    expect((await savedStarts()).length).toBeLessThanOrEqual(1);
    expect(actor.state.roots).toHaveLength(1);
  } finally { await computer.close(); }
}
it.each(['routine.run_activation_admitted', 'send', 'computer.turn_started'])(
  'never redelivers after losing %s reply', losesReply);


async function refusesChangedStart(field: string) {
  const authority = sender();
  const computer = await recordingComputer();
  const link = await computer.wake();
  const send = link.socket.send.bind(link.socket);
  function alter(bytes: Parameters<typeof send>[0]) {
    const text = z.string().parse(bytes);
    const frame = frameSchema.parse(JSON.parse(text));
    frame[field] = 'different';
    send(JSON.stringify(frame));
  }
  vi.spyOn(link.socket, 'send').mockImplementationOnce(alter);
  function closed() {
    return link.socket.readyState === link.socket.CLOSED || computer.closedSessions > 0;
  }
  try {
    await authority.send(computer.wake);
    await until(closed);
    expect(await savedStarts()).toEqual([]);
    expect(computer.starts).toBe(0);
  } finally { await computer.close(); }
}
it.each(['messageId', 'id', 'rootId', 'senderAttemptId', 'threadId',
  'conversationId', 'assistantId', 'requesterId'])(
  'refuses changed %s through real report admission', refusesChangedStart);

async function changesAtStartAppend() {
  const authority = sender();
  const computer = await recordingComputer();
  const append = nats.store.append.bind(nats.store);
  let attempted = false;
  async function loseOwnership(...args: Parameters<typeof append>) {
    const proposed = proposedEvent.parse(args[0].event);
    if (proposed.type === 'computer.turn_started') {
      attempted = true;
      owned = false;
    }
    return append(...args);
  }
  vi.spyOn(nats.store, 'append').mockImplementation(loseOwnership);
  function reachedAppend() {
    return attempted;
  }
  try {
    await authority.send(computer.wake);
    await until(reachedAppend);
    const link = await computer.wake();
    await link.settled();
    expect(await savedStarts()).toEqual([]);
    expect(computer.starts).toBe(0);
  } finally { await computer.close(); }
}
it('rechecks live authority inside the computer start append', changesAtStartAppend);


async function wrongComputerLink() {
  const computer = await recordingComputer('other-computer');
  try {
    expect(await sender().send(computer.wake)).toEqual({ status: 'unknown' });
    expect(computer.sends).toBe(0);
    expect(await savedStarts()).toEqual([]);
  } finally { await computer.close(); }
}
it('keeps routine instructions off a connection for another computer', wrongComputerLink);

async function refusesLateChange(kind: string) {
  const computer = await recordingComputer();
  const append = nats.store.append.bind(nats.store);
  let injected = false;
  async function changed(...args: Parameters<typeof append>) {
    const result = await append(...args);
    const proposed = proposedEvent.parse(args[0].event);
    if (!injected && proposed.type === 'computer.turn_started' && result.status === 'appended') {
      injected = true;
      if (kind === 'Stop') {
        const stoppedData = { rootId: actor.state.roots[0]!.rootId,
          reason: 'allowance_exhausted', attemptedBoundCents: 1, availableCents: 0 };
        const stopped = record('late-stop', 'budget-test', 'budget.root_stopped', stoppedData);
        stopped.source = 'models';
        stopped.principal = { kind: 'system', id: 'models' };
        await nats.seed([stopped]);
      } else if (kind === 'payer') {
        const removed = { teamId: 'sales', memberId: 'alice', removedBy: 'admin' };
        const removal = record('late-payer', 'team-sales', 'team.member_removed', removed);
        await nats.seed([removal]);
      } else {
        await changes(kind);
      }
    }
    return result;
  }
  vi.spyOn(nats.store, 'append').mockImplementation(changed);
  try {
    await sender().send(computer.wake);
    const link = await computer.wake();
    function completed() {
      return computer.starts > 0 || link.socket.readyState === link.socket.CLOSED;
    }
    await until(completed);
    expect(injected).toBe(true);
    expect(computer.starts).toBe(0);
    expect(await savedStarts()).toHaveLength(1);
  } finally {
    await computer.close();
  }
}
it.each(['Stop', 'grant', 'payer', 'worker', 'routine.paused', 'member', 'computer'])(
  'refuses late %s after saving the start and before releasing credentials', refusesLateChange);

async function acceptsOtherThread() {
  const computer = await recordingComputer();
  const append = nats.store.append.bind(nats.store);
  let injected = false;
  async function changed(...args: Parameters<typeof append>) {
    const proposed = proposedEvent.parse(args[0].event);
    if (!injected && proposed.type === 'computer.turn_started') {
      injected = true;
      const otherStart = { assistantId: 'sales-assistant', computerId: 'computer',
        conversationId: 'another-chat', turnId: 'another-turn', threadId: 'another-thread',
        requesterId: 'alice', task: 'chat_turn', executionMode: 'restricted' };
      const started = record('other-start', 'computer-sales-assistant',
        'computer.turn_started', otherStart);
      await nats.seed([started]);
    }
    return append(...args);
  }
  vi.spyOn(nats.store, 'append').mockImplementation(changed);
  try {
    await sender().send(computer.wake);
    const link = await computer.wake();
    function completed() {
      return computer.starts > 0 || link.socket.readyState === link.socket.CLOSED;
    }
    await until(completed);
    expect(injected).toBe(true);
    expect(computer.starts).toBe(1);
    expect(await savedStarts()).toHaveLength(2);
  } finally {
    await computer.close();
  }
}
it('retries an unsaved start after another computer thread advances its stream', acceptsOtherThread);


async function refusesRelevantComputerChange(kind: string) {
  const computer = await recordingComputer();
  const append = nats.store.append.bind(nats.store);
  let injected = false;
  async function changeBeforeAppend(...args: Parameters<typeof append>) {
    const proposed = proposedEvent.parse(args[0].event);
    if (!injected && proposed.type === 'computer.turn_started') {
      injected = true;
      if (kind === 'replacement') {
        await changes('computer');
      } else {
        const competingStart = { assistantId: 'sales-assistant', computerId: 'computer',
          conversationId, turnId: 'competing-turn', threadId: selection.threadId,
          requesterId: 'alice', task: 'chat_turn', executionMode: 'restricted' };
        const competing = record('competing-start', 'computer-sales-assistant',
          'computer.turn_started', competingStart);
        await nats.seed([competing]);
      }
    }
    return append(...args);
  }
  vi.spyOn(nats.store, 'append').mockImplementation(changeBeforeAppend);
  try {
    await sender().send(computer.wake);
    const link = await computer.wake();
    function completed() {
      return computer.starts > 0 || link.socket.readyState === link.socket.CLOSED;
    }
    await until(completed);
    expect(injected).toBe(true);
    expect(computer.starts).toBe(0);
    const starts = await savedStarts();
    for (const start of starts) {
      expect(start.event.data).not.toMatchObject({ turnId });
    }
  } finally {
    await computer.close();
  }
}
it.each(['replacement', 'selected thread'])(
  'refuses %s activity while saving the computer start', refusesRelevantComputerChange);

function preparationIdentity(id = turnId) {
  return { id, conversationId, assistantId: 'sales-assistant', requesterId: 'alice',
    expiresAt: Date.now() + 50_000 };
}
async function keepsNativeSession() {
  const computer = preparedComputer;
  const link = await computer.wake();
  const second = await link.prepareRoutineThread(preparationIdentity('other-turn'));
  expect(second).toBe('native-thread-2');
  expect(selection.threadId).toBe('native-thread-1');
  await sender().send(computer.wake);
  await until(computer.executed);
  expect(computer.nativeStarts).toBe(2);
  expect(computer.executedThreads).toEqual(['native-thread-1']);
  expect(actor.state.roots[0]).toMatchObject({ threadId: 'native-thread-1' });
  expect(await savedStarts()).toHaveLength(1);
}
it('retains the first native session when another start returns a distinct id', keepsNativeSession);

async function refusesSecondPreparation() {
  const link = await preparedComputer.wake();
  let refusal: unknown;
  function rememberRefusal(error: unknown) {
    refusal = error;
  }
  const preparation = link.prepareRoutineThread(preparationIdentity());
  const settled = preparation.catch(rememberRefusal);
  function promptlyRefused() {
    expect(refusal).toEqual(new Error('Routine thread unavailable'));
  }
  await vi.waitFor(promptlyRefused);
  await settled;
  expect(link.socket.readyState).toBe(link.socket.OPEN);
  expect(preparedComputer.nativeStarts).toBe(1);
  expect(preparedComputer.starts).toBe(0);
  function released() {
    return preparedComputer.closedSessions === 1;
  }
  await until(released);
}
it('refuses a second preparation for the same turn and closes its private session',
  refusesSecondPreparation);

async function refusesExpiredPreparation() {
  const clock = Date.now();
  function expired() { return clock + 61_000; }
  const dateClock = vi.spyOn(Date, 'now');
  dateClock.mockImplementation(expired);
  const link = await preparedComputer.wake();
  await sender().send(preparedComputer.wake);
  function finished() {
    return link.socket.readyState === link.socket.CLOSED || preparedComputer.closedSessions === 1;
  }
  await until(finished);
  expect(preparedComputer.starts).toBe(0);
  expect(preparedComputer.nativeStarts).toBe(1);
}
it('refuses delivery after the empty private session expires', refusesExpiredPreparation);


async function saveProhibition(kind: 'Stop' | 'Pause' | 'Retire') {
  const request = { routineId: 'orders', changeId: 'orders:bridge-stop',
    expectedPosition: await nats.store.head('routine-orders'),
    expectedDefinitionRevision: 1, expectedScheduleRevision: 1, expectedControlRevision: 1 };
  if (kind === 'Stop') {
    return requestRoutineStop(nats.store, binding, 'alice', { ...request, occurrenceId: 'occurrence' });
  }
  const command = kind === 'Pause' ? pauseRoutine : retireRoutine;
  return command(nats.store, binding, 'alice', request);
}
async function pollRoutine() {
  const link = await preparedComputer.wake();
  function connected() { return link; }
  function connectionId() { return 1; }
  const options = { silo: 'test', store: nats.store, keys, db: undefined! };
  const logger = createLogger('routine-stop-test', { level: 'silent' });
  const processor = assistantProcessor(options, preparedComputer.tokens, new Set(), forbidden,
    connectionId, logger, connected);
  const sessions = [{ conversationId, assistantId: 'sales-assistant', createdBy: 'alice',
    mode: 'agent_session' as const, createdAt: new Date().toISOString(), assistantKind: 'team' as const }];
  await Promise.all(processor.pollRoutines(sessions));
}
async function runningProhibition(kind: 'Stop' | 'Pause' | 'Retire') {
  expect(await sender().send(preparedComputer.wake)).toEqual({ status: 'sent' });
  await until(preparedComputer.executed);
  await saveProhibition(kind);
  const observed = performance.now();
  await pollRoutine();
  function interrupted() {
    expect(preparedComputer.interruptedThreads).toEqual([selection.threadId]);
  }
  await vi.waitFor(interrupted);
  expect(performance.now() - observed).toBeLessThan(2000);
  await Promise.all([pollRoutine(), pollRoutine()]);
  interrupted();
  const link = await preparedComputer.wake();
  expect(link.socket.readyState).toBe(link.socket.OPEN);
  expect(preparedComputer.closedSessions).toBe(0);
  const rows = await history(nats.store, 'routine-orders', 'test');
  let state;
  for (const row of rows) state = foldRoutine(state, row.event);
  expect(state?.activeRun?.occurrenceId).toBe('occurrence');
  expect(state?.lastRun).toBeNull();
}
it.each(['Stop', 'Pause', 'Retire'] as const)(
  'polls saved owner %s and interrupts only the accepted native routine turn once', runningProhibition);


async function startRunning() {
  expect(await sender().send(preparedComputer.wake)).toEqual({ status: 'sent' });
  await until(preparedComputer.executed);
  return preparedComputer.wake();
}
function interruptedOnce() {
  expect(preparedComputer.interruptedThreads).toEqual([selection.threadId]);
}
async function retriesRoutineStop(failure: 'send' | 'cleanup') {
  const link = await startRunning();
  await saveProhibition('Stop');
  if (failure === 'send') {
    vi.spyOn(link.socket, 'send').mockImplementationOnce(forbidden);
  } else {
    preparedComputer.faults.failRemoval = true;
  }
  await pollRoutine();
  await new Promise(setImmediate);
  expect(preparedComputer.interruptedThreads).toEqual([]);
  await pollRoutine();
  await vi.waitFor(interruptedOnce);
  expect(link.socket.readyState).toBe(link.socket.OPEN);
}
it.each(['send', 'cleanup'] as const)('retries failed routine Stop %s without closing neighbours',
  retriesRoutineStop);

async function delayedNativeStart() {
  preparedComputer.faults.delayStart = true;
  await startRunning();
  await saveProhibition('Pause');
  await pollRoutine();
  expect(preparedComputer.interruptedThreads).toEqual([]);
  preparedComputer.releaseStart();
  await vi.waitFor(interruptedOnce);
  await pollRoutine();
  interruptedOnce();
  expect(preparedComputer.starts).toBe(1);
}
it('cancels a delayed native start reply without executing another turn', delayedNativeStart);

async function runningNeighbour(link: Awaited<ReturnType<typeof preparedComputer.wake>>) {
  await apply([joinedMember('bob')]);
  keys.provision('test', 'neighbour-chat');
  const encrypted = keys.encrypt('test', 'neighbour-chat', 'Private routine instructions');
  await nats.seed([
    record('neighbour-chat', 'conversation-neighbour-chat', 'conversation.created',
      { conversationId: 'neighbour-chat', assistantId: 'sales-assistant', createdBy: 'bob',
        payingGroupId: 'billing', mode: 'agent_session' }),
    record('neighbour', 'conversation-neighbour-chat', 'message.posted',
      { conversationId: 'neighbour-chat', authorId: 'bob', authorKind: 'human',
        contentType: 'text', ...encrypted }),
    record('neighbour-start', 'computer-sales-assistant', 'computer.turn_started',
      { conversationId: 'neighbour-chat', turnId: 'neighbour', requesterId: 'bob',
        payingGroupId: 'billing', assistantId: 'sales-assistant', computerId: 'computer',
        threadId: 'native-thread-2', task: 'chat_turn', executionMode: 'restricted' }),
  ]);
  const frame = { type: 'turn', id: 'neighbour', conversationId: 'neighbour-chat',
    requesterId: 'bob', assistantId: 'sales-assistant', executionMode: 'restricted',
    text: 'Private routine instructions', token: 'preparing', expiresAt: Date.now() + 60_000 };
  link.socket.send(JSON.stringify(frame));
  function running() { expect(preparedComputer.starts).toBe(2); }
  await vi.waitFor(running, { timeout: 5000 });
}

async function boundedPrivateCleanup() {
  const link = await startRunning();
  await runningNeighbour(link);
  preparedComputer.faults.stallInterrupt = true;
  await saveProhibition('Retire');
  const observed = performance.now();
  await pollRoutine();
  await vi.waitFor(interruptedOnce);
  expect(preparedComputer.closedThreads).toEqual([]);
  function closed() { expect(preparedComputer.closedThreads).toEqual([selection.threadId]); }
  await vi.waitFor(closed, { timeout: 12_000 });
  expect(performance.now() - observed).toBeGreaterThanOrEqual(10_000);
  expect(performance.now() - observed).toBeLessThan(12_000);
  expect(link.socket.readyState).toBe(link.socket.OPEN);
  expect(preparedComputer.starts).toBe(2);
  preparedComputer.finish('native-thread-2');
  await link.settled();
}
it('closes only the uncooperative private routine process after ten seconds',
  boundedPrivateCleanup, 20_000);

async function rejectsChangedTarget(change: 'generation' | 'thread' | 'requester' | 'payer') {
  const link = await startRunning();
  await saveProhibition('Stop');
  if (change === 'generation') {
    await changes('computer');
  } else {
    // Challenge the live connection binding; saved admission remains the authority.
    const root = actor.state.roots[0]!;
    const changed = { ...root, task: 'chat_turn' as const, executionMode: 'restricted' as const };
    if (change === 'thread') changed.threadId = 'replacement-thread';
    if (change === 'requester') changed.requesterId = 'bob';
    if (change === 'payer') changed.payingGroupId = 'billing';
    link.routines.accept(changed);
  }
  await pollRoutine();
  expect(preparedComputer.interruptedThreads).toEqual([]);
  expect(preparedComputer.closedSessions).toBe(0);
  expect(link.socket.readyState).toBe(link.socket.OPEN);
}
it.each(['generation', 'thread', 'requester', 'payer'] as const)(
  'does not interrupt a replacement %s binding', rejectsChangedTarget);

async function disconnectedRoutineStop() {
  const link = await startRunning();
  await saveProhibition('Stop');
  link.socket.terminate();
  await once(link.socket, 'close');
  await pollRoutine();
  await preparedComputer.restart();
  await pollRoutine();
  expect(preparedComputer.starts).toBe(1);
  expect(preparedComputer.interruptedThreads).toEqual([]);
  expect(await sender().send(preparedComputer.wake)).toEqual({ status: 'unknown' });
}
it('lost connection and replay cannot resurrect the prohibited routine', disconnectedRoutineStop);


async function stoppedBeforeGrant() {
  const link = await preparedComputer.wake();
  const send = link.socket.send.bind(link.socket);
  let held: string | undefined;
  function holdGrant(bytes: Parameters<typeof send>[0]) {
    if (typeof bytes === 'string' && bytes.includes('"type":"ack"') && bytes.includes('"token"')) {
      held = bytes;
      return;
    }
    send(bytes);
  }
  vi.spyOn(link.socket, 'send').mockImplementation(holdGrant);
  expect(await sender().send(preparedComputer.wake)).toEqual({ status: 'sent' });
  function acknowledged() { expect(held).toBeDefined(); }
  await vi.waitFor(acknowledged, { timeout: 5000 });
  await saveProhibition('Stop');
  await pollRoutine();
  function closed() { expect(preparedComputer.closedSessions).toBe(1); }
  await vi.waitFor(closed);
  send(held!);
  await pollRoutine();
  expect(preparedComputer.starts).toBe(0);
  expect(preparedComputer.interruptedThreads).toEqual([]);
  expect(link.socket.readyState).toBe(link.socket.OPEN);
}
it('Stop before the start grant prevents execution even when the old grant arrives', stoppedBeforeGrant);

async function wrongTerminal() {
  const link = await startRunning();
  await saveProhibition('Stop');
  await pollRoutine();
  await vi.waitFor(interruptedOnce);
  preparedComputer.finish(selection.threadId, 'unrelated-completed-turn');
  await new Promise(setImmediate);
  await link.settled();
  expect(preparedComputer.closedSessions).toBe(0);
  preparedComputer.finish(selection.threadId);
  function closed() { expect(preparedComputer.closedSessions).toBe(1); }
  await vi.waitFor(closed);
  await link.settled();
  await pollRoutine();
  interruptedOnce();
}
it('retains Stopping after an unrelated terminal report and ends only the exact native turn',
  wrongTerminal);

async function prohibitionBeforeAdmission() {
  const link = await preparedComputer.wake();
  const append = nats.store.append.bind(nats.store);
  async function prohibitAfterReport(...args: Parameters<typeof append>) {
    const result = await append(...args);
    if (proposedEvent.parse(args[0].event).type === 'agent.turn_started') {
      await saveProhibition('Stop');
    }
    return result;
  }
  vi.spyOn(nats.store, 'append').mockImplementation(prohibitAfterReport);
  expect(await sender().send(preparedComputer.wake)).toEqual({ status: 'sent' });
  function closed() { expect(preparedComputer.closedSessions).toBe(1); }
  await vi.waitFor(closed, { timeout: 5000 });
  expect(preparedComputer.starts).toBe(0);
  expect(link.socket.readyState).toBe(link.socket.OPEN);
}
it('prohibition before start admission refuses only the routine and keeps the shared bridge',
  prohibitionBeforeAdmission);
