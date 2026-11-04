import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { dirname } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { encodeSession } from '@opencrane/auth';
import { testAuthConfig } from '@opencrane/auth/testing';
import { fixture } from '@opencrane/models/testing';
import { memoryWrittenDataSchema } from '@opencrane/events';
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
const config = testAuthConfig({ expectedOrgId: 'org-test' });
const scopeId = memoryScopeId('test', 'person', 'alice');
const canary = 'Private completed reply — £';
function memberId(_silo: string, _issuer: string, sub: string) { return Promise.resolve(sub); }
async function initialise() {
  setup = await fixture(2000, 20000, false, 'gpt-6-luna', true);
  await setup.runner.initialise(conversations);
  await setup.runner.initialise(computers);
  feed = await connectMemberFeed(setup.databaseUrl!);
  const options = { silo: 'test', store: setup.nats.store, db: setup.db, keys: setup.keys,
    binding: setup.binding, feed: { memberId } };
  app = buildServer(config, { chat: options });
  wss = attachWebSocketServer(app.server, app.log, config,
    { feed, binding: setup.binding, chat: options });
  address = await app.listen({ host: '127.0.0.1', port: 0 });
  bridge = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(bridge, 'listening');
  const location = bridge.address();
  if (!location || typeof location === 'string') throw new Error('Missing bridge address');
  const connected = once(bridge, 'connection');
  link = await connectBridge(options, { url: `ws://127.0.0.1:${location.port}`,
    assistantId: 'assistant', computerId: 'computer', bearer: 'fixture' });
  const connection: unknown[] = await connected;
  if (!(connection[0] instanceof WebSocket)) throw new Error('Missing bridge peer');
  peer = connection[0];
  for (const [resourceType, resourceId] of [['mcp_server', 'memory'], ['memory_read', scopeId]]) {
    for (const [granteeKind, granteeId] of [['member', 'alice'], ['assistant', 'assistant']]) {
      const saved = await setup.append(grantStream(resourceType!, resourceId!), 'grant.given',
        { resourceType, resourceId, granteeKind, granteeId, grantedBy: 'alice' });
      await setup.auth.handler.handle(saved, setup.db);
    }
  }
  const keys = memoryKeys(dirname(setup.nats.env().NATS_CA_FILE));
  const identity = { silo: 'test', scopeId, scopeKind: 'person' as const,
    ownerId: 'alice', memoryId: 'fact', revision: 1 };
  keys.provision(identity);
  await setup.append(`scope-${scopeId}`, 'memory.written', { scopeId, scopeKind: 'person', ownerId: 'alice', memoryId: 'fact', revision: 1,
    schemaVersion: 1,
    kind: 'fact', pinned: true, expiresAt: new Date(Date.now() + 90_000).toISOString(), sources: [], dependsOn: [],
    ...keys.encrypt(identity, 'A remembered fact') });
  await session('first');
  await session('second');
  const joined = await setup.append('member-bob', 'member.joined', { memberId: 'bob',
    email: 'bob@example.test', displayName: 'Bob', role: 'member' });
  await setup.auth.handler.handle(joined, setup.db);
  await setup.append('team-sales', 'team.member_added',
    { teamId: 'sales', memberId: 'bob', addedBy: 'alice' });
  await session('bob', 'bob');
  await setup.runner.run(conversations);
  await setup.runner.run(computers);
}
async function session(conversationId: string, requesterId = 'alice') {
  setup.keys.provision('test', conversationId);
  await setup.append(`conversation-${conversationId}`, 'conversation.created', {
    conversationId, createdBy: requesterId, assistantId: 'assistant', mode: 'agent_session',
    payingGroupId: 'sales' });
  const message = envelope('test', `conversation-${conversationId}`, 'message.posted', {
    conversationId, authorId: requesterId, authorKind: 'human', contentType: 'text',
    ...setup.keys.encrypt('test', conversationId, 'Human request') });
  await setup.nats.seed([{ ...message, id: conversationId, commandId: conversationId }]);
  await setup.append('computer-assistant', 'computer.turn_started', {
    conversationId, turnId: conversationId, requesterId, assistantId: 'assistant',
    computerId: 'computer', threadId: conversationId, task: 'chat_turn',
    executionMode: 'restricted', payingGroupId: 'sales' });
  const data = { conversationId, turnId: conversationId, requesterId, assistantId: 'assistant',
    computerId: 'computer', threadId: conversationId, generation: 1, inputGeneration: 'input',
    projectionGeneration: '1', action: 'prepared', delivery: null, callDigest: null,
    dispatchDigest: null, additions: [], scopePositions: [], byteCount: 0,
    hasOmissions: false, reason: 'none' };
  await contextRecord(conversationId, data);
  const reference = { scopeId, memoryId: 'fact', revision: 1 };
  const scopePosition = { scopeId, position: await setup.nats.store.head(`scope-${scopeId}`) };
  await contextRecord(conversationId, {
    ...data, action: 'loaded', delivery: 'initial',
    additions: requesterId === 'alice' ? [reference] : [],
    scopePositions: [scopePosition] });
}
async function contextRecord(conversationId: string, data: object) {
  const id = randomUUID();
  await setup.nats.seed([{ id, commandId: id, type: 'agent.memory_context_recorded',
    silo: 'test', subject: `conversation-${conversationId}`, source: 'opencrane-server',
    time: new Date().toISOString(), correlation: {}, principal: { kind: 'system', id: 'server' }, data }]);
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
  const socket = new WebSocket(`${address.replace('http:', 'ws:')}/ws`, { headers });
  clients.push(socket);
  const frames: unknown[] = [];
  function receive(raw: Buffer) { frames.push(JSON.parse(raw.toString()) as unknown); }
  socket.on('message', receive);
  await once(socket, 'open');
  socket.send(JSON.stringify({ type: 'subscribe', topic: 'conversation', conversationId, since: 0 }));
  function ready() { expect(JSON.stringify(frames)).toContain('"ready"'); }
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
  expect(JSON.parse(raw.toString())).toEqual({ type: 'ack', sequence: value.sequence });
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
  function delivered() { expect(privateFrames(first.frames)).toHaveLength(1); }
  await vi.waitFor(delivered);
  const frame = privateFrames(first.frames)[0];
  expect(privateReplySchema.parse(frame)).toMatchObject({ type: 'private_reply',
    conversationId: 'first', turnId: 'first', threadId: 'first', inputGeneration: 'input',
    data: { text: canary, turnId: 'first' } });
  expect(frame).not.toHaveProperty('position');
  expect(privateFrames(second.frames)).toEqual([]);
  expect(privateFrames(bob.frames)).toEqual([]);
  await send();
  await send({ ...report(), sequence: 2, previousSequence: 1 });
  expect(privateFrames(first.frames)).toHaveLength(1);
  expect(encrypt).not.toHaveBeenCalled();
  await send({ ...report(), conversationId: 'bob', turnId: 'bob', threadId: 'bob', sequence: 3 });
  await send({ ...report(), conversationId: 'second', turnId: 'second', threadId: 'second', sequence: 4 });
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
  await send({ ...report(), ...change });
  expect(privateFrames(client.frames)).toEqual([]);
}
it.each([{ threadId: 'second' }, { inputGeneration: 'late' }, { generation: 2 }])(
  'refuses a mismatched private binding %j', refusesBinding);
function strictNotification() {
  const frame = { version: 1, topic: 'conversation', type: 'private_reply',
    conversationId: 'first', turnId: 'first', threadId: 'first', generation: 1,
    inputGeneration: 'input', data: { text: canary, turnId: 'first' } };
  expect(privateReplySchema.safeParse(frame).success).toBe(true);
  expect(privateReplySchema.safeParse({ ...frame, position: 1 }).success).toBe(false);
  expect(privateReplySchema.safeParse({ ...frame, data: { ...frame.data, secret: 'no' } }).success)
    .toBe(false);
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

async function releaseRace(kind: string) {
  const client = await subscribe();
  const buffers = vi.spyOn(Buffer, 'from');
  const scope = `scope-${scopeId}`;
  const scopePosition = await setup.nats.store.head(scope);
  const read = setup.nats.store.readStream.bind(setup.nats.store);
  let changed = false;
  async function* changeAfterRead(...args: Parameters<typeof read>) {
    yield* read(...args);
    if (changed || args[0] !== scope || (args[1] ?? 0) <= scopePosition) return;
    changed = true;
    if (kind === 'expiry') {
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 120_000);
    } else if (kind === 'removal') {
      await setup.append('member-alice', 'member.removed', { memberId: 'alice', removedBy: 'owner' });
    } else if (kind === 'forget') {
      await setup.append(scope, 'memory.forgotten', { schemaVersion: 1, scopeId,
        scopeKind: 'person', ownerId: 'alice', memoryId: 'fact', revision: 2, expectedRevision: 1 });
    } else if (kind === 'correct') {
      const rows = await history(setup.nats.store, scope, 'test');
      const data = memoryWrittenDataSchema.parse(rows[0]!.event.data);
      await setup.append(scope, 'memory.corrected', { ...data, revision: 2, expectedRevision: 1,
        supersedes: { memoryId: 'fact', revision: 1 }, reason: 'human' });
    } else if (kind === 'socket') {
      const closed = once(client.socket, 'close');
      client.socket.terminate();
      await closed;
    } else if (kind === 'slow') {
      const subscriber = [...wss.clients][0]!;
      vi.spyOn(subscriber, 'bufferedAmount', 'get').mockReturnValue(64 * 1024);
    } else {
      await setup.append('conversation-first', 'message.posted', { conversationId: 'first',
        authorId: 'alice', authorKind: 'human', contentType: 'text',
        ...setup.keys.encrypt('test', 'first', 'An unrelated question') });
    }
  }
  vi.spyOn(setup.nats.store, 'readStream').mockImplementation(changeAfterRead);
  await send();
  expect(changed).toBe(true);
  let cleared = false;
  for (const [index, call] of buffers.mock.calls.entries()) {
    if (call[0] !== canary) continue;
    const buffer: unknown = buffers.mock.results[index]?.value;
    if (!Buffer.isBuffer(buffer)) throw new Error('Missing retained buffer');
    expect(buffer.equals(Buffer.alloc(buffer.length))).toBe(true);
    cleared = true;
  }
  expect(cleared).toBe(true);
  expect(privateFrames(client.frames)).toHaveLength(kind === 'unrelated' ? 1 : 0);
}
it.each(['correct', 'forget', 'expiry', 'removal', 'socket', 'slow', 'unrelated'])(
  'rechecks and clears bytes when %s happens during the final reference read', releaseRace);
async function refusesUntrustedReport(extra: object) {
  const client = await subscribe();
  const closed = once(peer, 'close');
  peer.send(JSON.stringify({ ...report(), ...extra }));
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
  vi.spyOn(setup.nats.store, 'append').mockImplementationOnce(lose);
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
