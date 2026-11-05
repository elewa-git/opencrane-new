import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { dirname } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { encodeSession } from '@opencrane/auth';
import { testAuthConfig } from '@opencrane/auth/testing';
import { fixture } from '@opencrane/models/testing';
import { memoryContextRecordedEventSchema, memoryWrittenDataSchema } from '@opencrane/events';
import { history, envelope } from '@opencrane/models';
import { grantStream } from '@opencrane/authz';
import { connectMemberFeed, conversations, computers, memoryKeys, memoryScopeId, readConversation }
  from '@opencrane/projections';
import { privateReplySchema } from '@opencrane/protocol';
import { buildServer } from '../src/server.ts';
import { attachWebSocketServer } from '../src/websocket.ts';
import { connectBridge } from '../src/chat/bridge.ts';

let setup: Awaited<ReturnType<typeof fixture>>;
let app: ReturnType<typeof buildServer>;
let feed: Awaited<ReturnType<typeof connectMemberFeed>>;
let wss: ReturnType<typeof attachWebSocketServer>;
let bridge: WebSocketServer;
let link: Awaited<ReturnType<typeof connectBridge>>;
let peer: WebSocket;
let address: string;
const clients: WebSocket[] = [];
const authOptions = { expectedOrgId: 'org-test' };
const config = testAuthConfig(authOptions);
const scopeId = memoryScopeId('test', 'person', 'alice');
const canary = 'Private completed reply — £';
function memberId(_silo: string, _issuer: string, sub: string) {
  return Promise.resolve(sub);
}
async function initialise() {
  setup = await fixture(2000, 20000, false, 'gpt-6-luna', true);
  await setup.runner.initialise(conversations);
  await setup.runner.initialise(computers);
  feed = await connectMemberFeed(setup.databaseUrl!);
  const options = { silo: 'test', store: setup.nats.store, db: setup.db, keys: setup.keys,
    binding: setup.binding, feed: { memberId } };
  const serverOptions = { chat: options };
  app = buildServer(config, serverOptions);
  const websocketOptions = { feed, binding: setup.binding, chat: options };
  wss = attachWebSocketServer(app.server, app.log, config, websocketOptions);
  const listenOptions = { host: '127.0.0.1', port: 0 };
  address = await app.listen(listenOptions);
  bridge = new WebSocketServer(listenOptions);
  await once(bridge, 'listening');
  const location = bridge.address();
  if (!location || typeof location === 'string') throw new Error('Missing bridge address');
  const connected = once(bridge, 'connection');
  const bridgeOptions = { url: `ws://127.0.0.1:${location.port}`,
    assistantId: 'assistant', computerId: 'computer', bearer: 'fixture' };
  link = await connectBridge(options, bridgeOptions);
  const connection: unknown[] = await connected;
  if (!(connection[0] instanceof WebSocket)) throw new Error('Missing bridge peer');
  peer = connection[0];
  for (const [resourceType, resourceId] of [['mcp_server', 'memory'], ['memory_read', scopeId]]) {
    for (const [granteeKind, granteeId] of [['member', 'alice'], ['assistant', 'assistant']]) {
      const grant = { resourceType, resourceId, granteeKind, granteeId, grantedBy: 'alice' };
      const subject = grantStream(resourceType!, resourceId!);
      const saved = await setup.append(subject, 'grant.given', grant);
      await setup.auth.handler.handle(saved, setup.db);
    }
  }
  const keys = memoryKeys(dirname(setup.nats.env().NATS_CA_FILE));
  const identity = { silo: 'test', scopeId, scopeKind: 'person' as const,
    ownerId: 'alice', memoryId: 'fact', revision: 1 };
  keys.provision(identity);
  const fact = { scopeId, scopeKind: 'person', ownerId: 'alice', memoryId: 'fact', revision: 1,
    schemaVersion: 1, kind: 'fact', pinned: true,
    expiresAt: new Date(Date.now() + 90_000).toISOString(), sources: [], dependsOn: [],
    ...keys.encrypt(identity, 'A remembered fact') };
  await setup.append(`scope-${scopeId}`, 'memory.written', fact);
  await session('first');
  await session('second');
  const bob = { memberId: 'bob', email: 'bob@example.test', displayName: 'Bob', role: 'member' };
  const joined = await setup.append('member-bob', 'member.joined', bob);
  await setup.auth.handler.handle(joined, setup.db);
  const membership = { teamId: 'sales', memberId: 'bob', addedBy: 'alice' };
  await setup.append('team-sales', 'team.member_added', membership);
  await session('bob', 'bob');
  await setup.runner.run(conversations);
  await setup.runner.run(computers);
}
async function session(conversationId: string, requesterId = 'alice') {
  setup.keys.provision('test', conversationId);
  const conversation = { conversationId, createdBy: requesterId, assistantId: 'assistant',
    mode: 'agent_session', payingGroupId: 'sales' };
  const subject = `conversation-${conversationId}`;
  await setup.append(subject, 'conversation.created', conversation);
  const messageData = { conversationId, authorId: requesterId, authorKind: 'human',
    contentType: 'text', ...setup.keys.encrypt('test', conversationId, 'Human request') };
  const message = envelope('test', subject, 'message.posted', messageData);
  const messages = [{ ...message, id: conversationId, commandId: conversationId }];
  await setup.nats.seed(messages);
  const start = { conversationId, turnId: conversationId, requesterId, assistantId: 'assistant',
    computerId: 'computer', threadId: conversationId,
    executionMode: 'restricted' as const, payingGroupId: 'sales', task: 'chat_turn' as const };
  await setup.append('computer-assistant', 'computer.turn_started', start);
  const observed = { type: 'agent.turn_started', sequence: 1, conversationId,
    turnId: conversationId, threadId: conversationId };
  link.memory.observe(observed);
  await link.memory.accept(observed, start);
  const data = { conversationId, turnId: conversationId, requesterId, assistantId: 'assistant',
    computerId: 'computer', threadId: conversationId, generation: 1, inputGeneration: 'input',
    projectionGeneration: '1', action: 'prepared', delivery: null, callDigest: null,
    dispatchDigest: null, additions: [], scopePositions: [], byteCount: 0,
    hasOmissions: false, reason: 'none' };
  await contextRecord(conversationId, data);
  const reference = { scopeId, memoryId: 'fact', revision: 1 };
  const scopePosition = { scopeId, position: await setup.nats.store.head(`scope-${scopeId}`) };
  const loaded = { ...data, action: 'loaded', delivery: 'initial',
    additions: requesterId === 'alice' ? [reference] : [], scopePositions: [scopePosition] };
  await contextRecord(conversationId, loaded);
}
async function contextRecord(conversationId: string, data: object) {
  const id = randomUUID();
  const records = [{ id, commandId: id, type: 'agent.memory_context_recorded',
    silo: 'test', subject: `conversation-${conversationId}`, source: 'opencrane-server',
    time: new Date().toISOString(), correlation: {},
    principal: { kind: 'system' as const, id: 'server' }, data }];
  await setup.nats.seed(records);
}
async function cleanup() {
  vi.restoreAllMocks();
  for (const client of clients.splice(0)) client.terminate();
  link?.socket.terminate();
  peer?.terminate();
  await link?.settled();
  bridge?.close();
  wss?.close();
  await app?.close();
  await feed?.close();
  await setup?.close();
}
beforeEach(initialise, 60_000);
afterEach(cleanup, 30_000);
async function subscribe(conversationId = 'first', sub = 'alice') {
  const session = { sub, orgId: 'org-test', roles: [], authTime: 0,
    exp: Math.floor(Date.now() / 1000) + 3600 };
  const headers = { cookie: `${config.cookieName}=${encodeSession(config, session)}`,
    origin: new URL(config.redirectUri).origin };
  const websocketOptions = { headers };
  const socket = new WebSocket(`${address.replace('http:', 'ws:')}/ws`, websocketOptions);
  clients.push(socket);
  const frames: unknown[] = [];
  function receive(raw: Buffer) {
    const frame: unknown = JSON.parse(raw.toString());
    frames.push(frame);
  }
  socket.on('message', receive);
  await once(socket, 'open');
  const subscription = { type: 'subscribe', topic: 'conversation', conversationId, since: 0 };
  const encoded = JSON.stringify(subscription);
  socket.send(encoded);
  function ready() {
    expect(JSON.stringify(frames)).toContain('"ready"');
  }
  await vi.waitFor(ready);
  return { socket, frames };
}
function report() {
  return { type: 'private_reply', conversationId: 'first', turnId: 'first', threadId: 'first',
    generation: 1, inputGeneration: 'input', sequence: 1, previousSequence: 0, text: canary };
}
async function send(value = report()) {
  const response = once(peer, 'message');
  peer.send(JSON.stringify(value));
  const closed = once(peer, 'close');
  const values: unknown[] = await Promise.race([response, closed]);
  const raw = values[0];
  if (!Buffer.isBuffer(raw)) throw new Error('Bridge closed without acknowledgement');
  const acknowledgement = { type: 'ack', sequence: value.sequence };
  expect(JSON.parse(raw.toString())).toEqual(acknowledgement);
  await link.settled();
}
function privateFrames(frames: unknown[]) {
  function privateFrame(frame: unknown) {
    return typeof frame === 'object' && frame !== null && 'type' in frame &&
      frame.type === 'private_reply';
  }
  return frames.filter(privateFrame);
}
async function isolatesAndConsumes() {
  const first = await subscribe();
  const second = await subscribe('second');
  const bob = await subscribe('bob', 'bob');
  const encrypt = vi.spyOn(setup.keys, 'encrypt');
  await send();
  function delivered() {
    expect(privateFrames(first.frames)).toHaveLength(1);
  }
  await vi.waitFor(delivered);
  const frame = privateFrames(first.frames)[0];
  const expectedFrame = { type: 'private_reply',
    conversationId: 'first', turnId: 'first', threadId: 'first', inputGeneration: 'input',
    data: { text: canary, turnId: 'first' } };
  expect(privateReplySchema.parse(frame)).toMatchObject(expectedFrame);
  expect(frame).not.toHaveProperty('position');
  expect(privateFrames(second.frames)).toEqual([]);
  expect(privateFrames(bob.frames)).toEqual([]);
  await send();
  const duplicate = { ...report(), sequence: 2, previousSequence: 1 };
  await send(duplicate);
  expect(privateFrames(first.frames)).toHaveLength(1);
  expect(encrypt).not.toHaveBeenCalled();
  const bobReport = { ...report(), conversationId: 'bob', turnId: 'bob', threadId: 'bob', sequence: 3 };
  await send(bobReport);
  const secondReport = { ...report(), conversationId: 'second', turnId: 'second',
    threadId: 'second', sequence: 4 };
  await send(secondReport);
  expect(privateFrames(bob.frames)).toHaveLength(1);
  expect(privateFrames(second.frames)).toHaveLength(1);
  expect(privateFrames(first.frames)).toHaveLength(1);
  await setup.runner.run(conversations);
  expect(JSON.stringify(await readConversation(setup.db, 'test', 'first'))).not.toContain(canary);
  const rows = await history(setup.nats.store, 'conversation-first', 'test');
  expect(JSON.stringify(rows)).not.toContain(canary);
  expect(rows.at(-1)?.event.type).toBe('agent.output_lost');
  first.socket.terminate();
  const reconnected = await subscribe();
  expect(privateFrames(reconnected.frames)).toEqual([]);
}
it('delivers once to the saved requester and exact session without saving or replaying bytes',
  isolatesAndConsumes);
async function refusesBinding(change: object) {
  const client = await subscribe();
  const changed = { ...report(), ...change };
  await send(changed);
  expect(privateFrames(client.frames)).toEqual([]);
}
it.each([{ threadId: 'second' }, { inputGeneration: 'late' }, { generation: 2 }])(
  'refuses a mismatched private binding %j', refusesBinding);
function strictNotification() {
  const frame = { version: 1, topic: 'conversation', type: 'private_reply',
    conversationId: 'first', turnId: 'first', threadId: 'first', generation: 1,
    inputGeneration: 'input', data: { text: canary, turnId: 'first' } };
  expect(privateReplySchema.safeParse(frame).success).toBe(true);
  const withPosition = { ...frame, position: 1 };
  expect(privateReplySchema.safeParse(withPosition).success).toBe(false);
  const withSecret = { ...frame, data: { ...frame.data, secret: 'no' } };
  expect(privateReplySchema.safeParse(withSecret).success).toBe(false);
}
it('checks a strict cursor-free notification using existing chat payload fields', strictNotification);

async function stopsDelivery(type: string) {
  const client = await subscribe();
  const data = type === 'agent.turn_stop_requested'
    ? { conversationId: 'first', turnId: 'first', requestedBy: 'alice' }
    : { conversationId: 'first', turnId: 'first', reason: 'model_error' };
  const completed = { conversationId: 'first', turnId: 'first' };
  await setup.append('conversation-first', type, type === 'agent.turn_completed' ? completed : data);
  await send();
  expect(privateFrames(client.frames)).toEqual([]);
}
it.each(['agent.turn_completed', 'agent.turn_failed', 'agent.turn_stop_requested'])(
  'clears a reply after %s', stopsDelivery);
async function noSubscriberReplay() {
  await send();
  const client = await subscribe();
  await send();
  expect(privateFrames(client.frames)).toEqual([]);
}
it('does not deliver an earlier report to a new subscriber', noSubscriberReplay);

async function releaseRace(kind: string, readNumber = 1, repeat = false,
  boundary: 'scope' | 'position' | 'conversation' = 'scope') {
  const client = await subscribe();
  const buffers = vi.spyOn(Buffer, 'from');
  const scope = `scope-${scopeId}`;
  const scopePosition = await setup.nats.store.head(scope);
  const read = setup.nats.store.readStream.bind(setup.nats.store);
  let changed = false;
  let incrementalReads = 0;
  async function* changeAfterRead(...args: Parameters<typeof read>) {
    yield* read(...args);
    const subject = boundary === 'conversation' ? 'conversation-first' : scope;
    if (args[0] !== subject || (args[1] ?? 0) <= scopePosition) return;
    if (boundary === 'conversation' && args[3] !== true) return;
    incrementalReads++;
    if (boundary === 'position' || incrementalReads < readNumber) return;
    await saveChange();
  }
  async function saveChange() {
    if (changed && !repeat) return;
    changed = true;
    if (kind === 'deadline') {
      const expired = performance.now() + 2001;
      const clock = vi.spyOn(performance, 'now');
      clock.mockReturnValue(expired);
    } else if (kind === 'expiry') {
      const clock = vi.spyOn(Date, 'now');
      clock.mockReturnValue(Date.now() + 120_000);
    } else if (kind === 'removal') {
      const removal = { memberId: 'alice', removedBy: 'owner' };
      await setup.append('member-alice', 'member.removed', removal);
    } else if (kind === 'forget') {
      const forget = { schemaVersion: 1, scopeId, scopeKind: 'person', ownerId: 'alice',
        memoryId: 'fact', revision: 2, expectedRevision: 1 };
      await setup.append(scope, 'memory.forgotten', forget);
    } else if (kind === 'correct') {
      const rows = await history(setup.nats.store, scope, 'test');
      const data = memoryWrittenDataSchema.parse(rows[0]!.event.data);
      const correction = { ...data, revision: 2, expectedRevision: 1,
        supersedes: { memoryId: 'fact', revision: 1 }, reason: 'human' };
      await setup.append(scope, 'memory.corrected', correction);
    } else if (kind === 'socket') {
      const closed = once(client.socket, 'close');
      client.socket.terminate();
      await closed;
    } else if (kind === 'slow') {
      const subscriber = [...wss.clients][0]!;
      const bufferedAmount = vi.spyOn(subscriber, 'bufferedAmount', 'get');
      bufferedAmount.mockReturnValue(64 * 1024);
    } else {
      const message = { conversationId: 'first', authorId: 'alice', authorKind: 'human',
        contentType: 'text', ...setup.keys.encrypt('test', 'first', 'An unrelated question') };
      await setup.append('conversation-first', 'message.posted', message);
    }
  }
  const streamRead = vi.spyOn(setup.nats.store, 'readStream');
  streamRead.mockImplementation(changeAfterRead);
  if (boundary === 'position') {
    const head = setup.nats.store.head.bind(setup.nats.store);
    async function delayedPosition(...args: Parameters<typeof head>) {
      const position = await head(...args);
      if (args[0] === scope && incrementalReads >= readNumber && !changed) {
        // Hold the old response until the other parallel position reads have finished.
        function finishDelay(resolve: () => void) {
          setTimeout(resolve, 20);
        }
        await new Promise<void>(finishDelay);
        await saveChange();
      }
      return position;
    }
    const positionRead = vi.spyOn(setup.nats.store, 'head');
    positionRead.mockImplementation(delayedPosition);
  }
  await send();
  expect(changed).toBe(true);
  expect(incrementalReads).toBeGreaterThanOrEqual(readNumber);
  let cleared = false;
  const bufferCalls = buffers.mock.calls.entries();
  for (const [index, call] of bufferCalls) {
    if (call[0] !== canary) continue;
    const buffer: unknown = buffers.mock.results[index]?.value;
    if (!Buffer.isBuffer(buffer)) throw new Error('Missing retained buffer');
    expect(buffer.equals(Buffer.alloc(buffer.length))).toBe(true);
    cleared = true;
  }
  expect(cleared).toBe(true);
  expect(privateFrames(client.frames)).toHaveLength(kind === 'unrelated' ? 1 : 0);
}
async function firstReadRace(kind: string) {
  await releaseRace(kind);
}
it.each(['correct', 'forget', 'expiry', 'removal', 'socket', 'slow', 'unrelated'])(
  'rechecks and clears bytes when %s happens during the first incremental scope read', firstReadRace);
async function secondReadRace(kind: string) {
  await releaseRace(kind, 2);
}
it.each(['removal', 'correct', 'forget'])(
  'delivers no frame when %s is saved during the second incremental scope read', secondReadRace);
async function continuousUnrelatedMessages() {
  await releaseRace('unrelated', 1, true);
}
it('delivers one frame with an unrelated message on every incremental scope read',
  continuousUnrelatedMessages);
async function positionReadRace(kind: string) {
  await releaseRace(kind, 2, false, 'position');
}
it.each(['removal', 'correct', 'forget'])(
  'delivers no frame when %s is saved while the scope position response is held', positionReadRace);
async function continuousConversationMessages() {
  await releaseRace('unrelated', 1, true, 'conversation');
}
it('delivers one frame with an unrelated message on every incremental conversation read',
  continuousConversationMessages);
async function originalDeadline() {
  await releaseRace('deadline', 2, false, 'position');
}
it('refuses delivery when the original deadline expires during position reads', originalDeadline);
async function refusesUntrustedReport(extra: object) {
  const client = await subscribe();
  const closed = once(peer, 'close');
  const untrusted = { ...report(), ...extra };
  const encoded = JSON.stringify(untrusted);
  peer.send(encoded);
  expect((await closed)[0]).toBe(1008);
  expect(privateFrames(client.frames)).toEqual([]);
}
it.each([{ requesterId: 'bob' }, { assistantId: 'other' }, { text: '£'.repeat(24 * 1024) }])(
  'refuses identity claims and oversized UTF-8 replies', refusesUntrustedReport);

async function losesAppendReply() {
  const client = await subscribe();
  const append = setup.nats.store.append.bind(setup.nats.store);
  async function lose(command: Parameters<typeof append>[0]): Promise<never> {
    await append(command);
    throw new Error('Fixture loses append acknowledgement');
  }
  const appendSpy = vi.spyOn(setup.nats.store, 'append');
  appendSpy.mockImplementationOnce(lose);
  const closed = once(peer, 'close');
  peer.send(JSON.stringify(report()));
  expect((await closed)[0]).toBe(1011);
  await link.settled();
  expect(privateFrames(client.frames)).toEqual([]);
  const rows = await history(setup.nats.store, 'conversation-first', 'test');
  expect(rows.at(-1)?.event.type).toBe('agent.output_lost');
  expect(JSON.stringify(rows)).not.toContain(canary);
}
it('clears an uncertain append without releasing or remembering reply bytes', losesAppendReply);

function clearanceFrames(frames: unknown[]) {
  function clearance(frame: unknown) {
    return typeof frame === 'object' && frame !== null && 'type' in frame &&
      frame.type === 'private_output_cleared';
  }
  return frames.filter(clearance);
}
function expectedClearance() {
  return { version: 1, topic: 'conversation', type: 'private_output_cleared',
    conversationId: 'first', turnId: 'first', threadId: 'first', generation: 1,
    inputGeneration: 'input' };
}
async function completedReply() {
  const client = await subscribe();
  await send();
  function delivered() {
    expect(privateFrames(client.frames)).toHaveLength(1);
  }
  await vi.waitFor(delivered);
  const completed = { conversationId: 'first', turnId: 'first' };
  await setup.append('conversation-first', 'agent.turn_completed', completed);
  return client;
}
async function changeFact(kind: string, memoryId = 'fact') {
  const subject = `scope-${scopeId}`;
  if (kind === 'expiry') {
    const expired = Date.now() + 120_000;
    const clock = vi.spyOn(Date, 'now');
    clock.mockReturnValue(expired);
  } else if (kind === 'revoke') {
    const resourceType = 'memory_read';
    const subject = grantStream(resourceType, scopeId);
    const data = { resourceType, resourceId: scopeId, granteeKind: 'member',
      granteeId: 'alice', revokedBy: 'alice' };
    const saved = await setup.append(subject, 'grant.revoked', data);
    await setup.auth.handler.handle(saved, setup.db);
  } else if (kind === 'correct') {
    const rows = await history(setup.nats.store, subject, 'test');
    const original = memoryWrittenDataSchema.parse(rows[0]!.event.data);
    const data = { ...original, memoryId, revision: 2, expectedRevision: 1,
      supersedes: { memoryId, revision: 1 }, reason: 'human' };
    await setup.append(subject, 'memory.corrected', data);
  } else {
    const data = { schemaVersion: 1, scopeId, scopeKind: 'person', ownerId: 'alice',
      memoryId, revision: 2, expectedRevision: 1 };
    await setup.append(subject, 'memory.forgotten', data);
  }
}
async function flushBrowser(client: WebSocket) {
  const pong = once(client, 'pong');
  client.ping();
  await pong;
}
async function clearsOriginalBrowser(kind: string) {
  const first = await completedReply();
  const sameChat = await subscribe();
  const second = await subscribe('second');
  const bob = await subscribe('bob', 'bob');
  await changeFact(kind);
  await link.memory.poll('first');
  await flushBrowser(first.socket);
  expect(clearanceFrames(first.frames)).toEqual([expectedClearance()]);
  expect(clearanceFrames(sameChat.frames)).toEqual([]);
  expect(clearanceFrames(second.frames)).toEqual([]);
  expect(clearanceFrames(bob.frames)).toEqual([]);
  await link.memory.poll('first');
  await flushBrowser(first.socket);
  expect(clearanceFrames(first.frames)).toHaveLength(1);
  expect(first.socket.readyState).toBe(WebSocket.OPEN);
}
it.each(['correct', 'forget', 'expiry', 'revoke'])(
  'clears only the original live browser after completed memory %s', clearsOriginalBrowser);

async function completeStoppedTurn() {
  const completed = { type: 'agent.turn_completed', conversationId: 'first', turnId: 'first',
    assistantId: 'assistant', sequence: 2, previousSequence: 1 };
  const response = once(peer, 'message');
  peer.send(JSON.stringify(completed));
  const values: unknown[] = await response;
  const raw = values[0];
  if (!Buffer.isBuffer(raw)) throw new Error('Missing completion acknowledgement');
  const acknowledgement = { type: 'ack', sequence: 2 };
  expect(JSON.parse(raw.toString())).toEqual(acknowledgement);
  await link.settled();
  const rows = await history(setup.nats.store, 'conversation-first', 'test');
  expect(rows.at(-1)?.event.type).toBe('agent.turn_completed');
}
async function clearsDeliveredReplyOnStop(completionBeforePoll: boolean) {
  const first = await subscribe();
  await send();
  await flushBrowser(first.socket);
  expect(privateFrames(first.frames)).toHaveLength(1);
  const laterSubscriber = await subscribe();
  const neighbourStop = { conversationId: 'first', turnId: 'neighbour', requestedBy: 'alice' };
  await setup.append('conversation-first', 'agent.turn_stop_requested', neighbourStop);
  await link.memory.poll('first');
  await flushBrowser(first.socket);
  expect(clearanceFrames(first.frames)).toEqual([]);
  const stop = { conversationId: 'first', turnId: 'first', requestedBy: 'alice' };
  await setup.append('conversation-first', 'agent.turn_stop_requested', stop);
  if (completionBeforePoll) await completeStoppedTurn();
  await link.memory.poll('first');
  await flushBrowser(first.socket);
  expect(clearanceFrames(first.frames)).toEqual([expectedClearance()]);
  if (!completionBeforePoll) await completeStoppedTurn();
  await link.memory.poll('first');
  await link.memory.poll('first');
  await flushBrowser(first.socket);
  await flushBrowser(laterSubscriber.socket);
  expect(clearanceFrames(first.frames)).toEqual([expectedClearance()]);
  expect(privateFrames(first.frames)).toHaveLength(1);
  expect(clearanceFrames(laterSubscriber.frames)).toEqual([]);
  expect(privateFrames(laterSubscriber.frames)).toEqual([]);
  expect(first.socket.readyState).toBe(WebSocket.OPEN);
}
it.each([false, true])(
  'clears a delivered reply once after saved Stop with completion before poll: %s',
  clearsDeliveredReplyOnStop);

async function prematureReceiptCannotForgetBrowser() {
  const first = await completedReply();
  const receipt = { type: 'private_output_cleared', conversationId: 'first',
    turnId: 'first', threadId: 'first' };
  link.memory.receive(receipt);
  await changeFact('forget');
  await link.memory.poll('first');
  await flushBrowser(first.socket);
  expect(clearanceFrames(first.frames)).toEqual([expectedClearance()]);
  link.memory.receive(receipt);
  await link.memory.poll('first');
  await flushBrowser(first.socket);
  expect(clearanceFrames(first.frames)).toHaveLength(1);
}
it('cannot use an unsolicited computer receipt to drop browser clearance',
  prematureReceiptCannotForgetBrowser);

async function clearsBridgeReplies() {
  const first = await completedReply();
  const second = await subscribe('second');
  const secondReport = { ...report(), conversationId: 'second', turnId: 'second',
    threadId: 'second', sequence: 2 };
  await send(secondReport);
  const closed = once(link.socket, 'close');
  link.socket.terminate();
  await closed;
  await flushBrowser(first.socket);
  await flushBrowser(second.socket);
  expect(clearanceFrames(first.frames)).toEqual([expectedClearance()]);
  const expected = { ...expectedClearance(), conversationId: 'second',
    turnId: 'second', threadId: 'second' };
  expect(clearanceFrames(second.frames)).toEqual([expected]);
}
it('clears every delivered reply bound to a lost bridge', clearsBridgeReplies);

async function closesOrReplaces(kind: string) {
  const first = await completedReply();
  if (kind === 'closed') {
    const data = { conversationId: 'first', closedBy: 'alice' };
    await setup.append('conversation-first', 'conversation.closed', data);
  } else {
    const data = { assistantId: 'assistant', computerId: 'computer', generation: 2,
      podUid: 'replacement' };
    await setup.append('computer-assistant', 'computer.ready', data);
  }
  await link.memory.poll('first');
  await flushBrowser(first.socket);
  expect(clearanceFrames(first.frames)).toEqual([expectedClearance()]);
}
it.each(['closed', 'replacement'])('clears delivered output when %s', closesOrReplaces);

async function disconnectedBrowserCannotRedirect() {
  const first = await completedReply();
  const closed = once(first.socket, 'close');
  first.socket.terminate();
  await closed;
  const replacement = await subscribe();
  await changeFact('forget');
  await link.memory.poll('first');
  await flushBrowser(replacement.socket);
  expect(clearanceFrames(replacement.frames)).toEqual([]);
}
it('drops disconnected browser tracking without notifying a new subscription',
  disconnectedBrowserCannotRedirect);

async function unrelatedActivityKeepsReply() {
  const first = await completedReply();
  await changeFact('forget', 'unrelated');
  const message = { conversationId: 'first', authorId: 'alice', authorKind: 'human',
    contentType: 'text', ...setup.keys.encrypt('test', 'first', 'Another question') };
  await setup.append('conversation-first', 'message.posted', message);
  const upload = { conversationId: 'first', fileId: 'upload', uploadedBy: 'alice',
    name: 'fixture.txt', mime: 'text/plain', size: 1, sha256: 'a'.repeat(64),
    objectKey: 'fixture' };
  await setup.append('conversation-first', 'file.uploaded', upload);
  const neighbour = { conversationId: 'first', turnId: 'neighbour' };
  await setup.append('conversation-first', 'agent.turn_completed', neighbour);
  await link.memory.poll('first');
  await flushBrowser(first.socket);
  expect(clearanceFrames(first.frames)).toEqual([]);
  expect(first.socket.readyState).toBe(WebSocket.OPEN);
  await changeFact('forget');
  await link.memory.poll('first');
  await flushBrowser(first.socket);
  expect(clearanceFrames(first.frames)).toEqual([expectedClearance()]);
}
it('keeps the reply and viewer open through unrelated facts, messages, uploads and turns',
  unrelatedActivityKeepsReply);

async function oldReceiptKeepsLaterReply(change: object) {
  const first = await completedReply();
  const stale = { type: 'private_output_cleared', conversationId: 'first',
    turnId: 'first', threadId: 'first', ...change };
  link.memory.receive(stale);
  await changeFact('forget');
  await link.memory.poll('first');
  await flushBrowser(first.socket);
  expect(clearanceFrames(first.frames)).toEqual([expectedClearance()]);
}
const staleThread = { threadId: 'old' };
const staleGeneration = { generation: 2 };
const staleInput = { inputGeneration: 'old' };
const staleTurn = { turnId: 'old' };
const otherConversation = { conversationId: 'second' };
const staleReceipts = [staleThread, staleGeneration, staleInput, staleTurn, otherConversation];
it.each(staleReceipts)(
  'cannot redirect or consume clearance with a stale receipt %j', oldReceiptKeepsLaterReply);

async function oldInvalidationKeepsNextReply() {
  const first = await completedReply();
  const rows = await history(setup.nats.store, 'conversation-first', 'test');
  const preparation = rows.find(isPreparation);
  if (!preparation) throw new Error('Missing fixture preparation');
  const original = memoryContextRecordedEventSchema.parse(preparation.event).data;
  const next = { ...original, turnId: 'next', threadId: 'next-thread', inputGeneration: 'next-input' };
  const message = { conversationId: 'first', authorId: 'alice', authorKind: 'human',
    contentType: 'text', ...setup.keys.encrypt('test', 'first', 'Next question') };
  const request = envelope('test', 'conversation-first', 'message.posted', message);
  const requests = [{ ...request, id: 'next', commandId: 'next' }];
  await setup.nats.seed(requests);
  const started = { conversationId: 'first', turnId: 'next', threadId: 'next-thread',
    requesterId: 'alice', assistantId: 'assistant', computerId: 'computer',
    task: 'chat_turn' as const, executionMode: 'restricted' as const, payingGroupId: 'sales' };
  await setup.append('computer-assistant', 'computer.turn_started', started);
  const observed = { ...started, type: 'agent.turn_started', sequence: 2 };
  link.memory.observe(observed);
  await link.memory.accept(observed, started);
  await contextRecord('first', next);
  const loaded = { ...next, action: 'loaded', delivery: 'initial' };
  await contextRecord('first', loaded);
  const reply = { ...report(), sequence: 2, previousSequence: 1, turnId: 'next', threadId: 'next-thread',
    inputGeneration: 'next-input' };
  await send(reply);
  await flushBrowser(first.socket);
  expect(privateFrames(first.frames)).toHaveLength(2);
  await changeFact('forget');
  await link.memory.poll('first');
  await flushBrowser(first.socket);
  expect(clearanceFrames(first.frames)).toEqual([expectedClearance()]);
  const receipt = { type: 'private_output_cleared', conversationId: 'first',
    turnId: 'first', threadId: 'first' };
  link.memory.receive(receipt);
  const closed = once(link.socket, 'close');
  link.socket.terminate();
  await closed;
  await flushBrowser(first.socket);
  const expected = { ...expectedClearance(), turnId: 'next', threadId: 'next-thread',
    inputGeneration: 'next-input' };
  expect(clearanceFrames(first.frames)).toEqual([expectedClearance(), expected]);
}
function isPreparation(row: Awaited<ReturnType<typeof history>>[number]) {
  return row.event.type === 'agent.memory_context_recorded';
}
it('keeps old turn, thread and input identities separate from the next delivered reply',
  oldInvalidationKeepsNextReply);
