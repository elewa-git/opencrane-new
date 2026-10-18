import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { encodeSession } from '@opencrane/auth';
import { natsFixture } from '@opencrane/event-store/testing';
import { createStore, memberAuthorisation } from '@opencrane/authz';
import { testAuthConfig } from '@opencrane/auth/testing';
import { connectMemberFeed, conversations, computers } from '@opencrane/projections';
import { budgetStopHandler, envelope, history } from '@opencrane/models';
import { fixture, fga } from '@opencrane/models/testing';
import { budgetStopStatusSchema, chatMessageSchema } from '@opencrane/protocol';
import { buildServer } from '../src/server.ts';
import { attachWebSocketServer } from '../src/websocket.ts';

let setup: Awaited<ReturnType<typeof fixture>>;
let app: ReturnType<typeof buildServer>;
let feed: Awaited<ReturnType<typeof connectMemberFeed>>;
let wss: ReturnType<typeof attachWebSocketServer>;
let address: string;
let turnId: string;
const sockets: WebSocket[] = [];
const config = testAuthConfig({ expectedOrgId: 'org-test' });
type Frame = ReturnType<typeof chatMessageSchema.parse>;
function headers(sub = 'alice') {
  const session = { sub, orgId: 'org-test', roles: [], authTime: 0,
    exp: Math.floor(Date.now() / 1000) + 3600 };
  return { cookie: `${config.cookieName}=${encodeSession(config, session)}`,
    origin: new URL(config.redirectUri).origin };
}
function memberId(_silo: string, _issuer: string, sub: string) {
  return Promise.resolve(sub);
}
async function initialise() {
  setup = undefined!;
  app = undefined!;
  feed = undefined!;
  wss = undefined!;
  setup = await fixture();
  await setup.runner.initialise(conversations);
  await setup.runner.initialise(computers);
  await setup.runner.run(computers);
  feed = await connectMemberFeed(setup.databaseUrl!);
  const chat = { silo: 'test', store: setup.nats.store, db: setup.db, keys: setup.keys,
    binding: setup.binding, feed: { memberId } };
  app = buildServer(config, { chat });
  const realtime = { feed, binding: setup.binding, chat };
  wss = attachWebSocketServer(app.server, app.log, config, realtime);
  address = await app.listen({ host: '127.0.0.1', port: 0 });
  await setup.append('computer-assistant', 'computer.turn_closed', {
    assistantId: 'assistant', computerId: 'computer', conversationId: 'conversation',
    turnId: 'turn', requesterId: 'alice', task: 'chat_turn', status: 'completed' });
  turnId = await message();
  await setup.runner.run(conversations);
}
async function close() {
  vi.restoreAllMocks();
  for (const socket of sockets.splice(0)) socket.terminate();
  if (wss) {
    function closeServer(resolve: () => void) { wss.close(resolve); }
    await new Promise<void>(closeServer);
  }
  await app?.close();
  await feed?.close();
  await setup?.close();
}
beforeEach(initialise, 60_000);
afterEach(close, 30_000);
async function message() {
  const encrypted = setup.keys.encrypt('test', 'conversation', 'A saved request');
  const saved = await setup.append('conversation-conversation', 'message.posted', {
    conversationId: 'conversation', authorKind: 'human', authorId: 'alice',
    ...encrypted, contentType: 'text' });
  return saved.id;
}
async function participant() {
  const joined = await setup.append('member-bob', 'member.joined', {
    memberId: 'bob', email: 'bob@example.test', displayName: 'Bob', role: 'admin' });
  await setup.auth.handler.handle(joined, setup.db);
  const added = await setup.append('participation-conversation', 'participant.added', {
    conversationId: 'conversation', participantId: 'bob', addedBy: 'alice' });
  await setup.auth.handler.handle(added, setup.db);
}
async function stop() {
  await setup.actor.configure({ scope: 'paying_group', scopeId: 'personal-default',
    ceilingCents: 0, setBy: 'alice' });
  const rows = await history(setup.nats.store, 'budget-test', 'test');
  const saved = rows.at(-1)!.event;
  await setup.runner.run(conversations);
  const handler = budgetStopHandler(setup.nats.store);
  await handler.handle(saved, setup.db);
  await handler.handle(saved, setup.db);
  await setup.runner.run(conversations);
  return saved.id;
}
async function connect(sub = 'alice', since = 0, generation = 0) {
  const options = { headers: headers(sub) };
  const socket = new WebSocket(`${address.replace('http:', 'ws:')}/ws`, options);
  sockets.push(socket);
  const frames: Frame[] = [];
  function receive(raw: Buffer) {
    frames.push(chatMessageSchema.parse(JSON.parse(raw.toString()) as unknown));
  }
  socket.on('message', receive);
  await once(socket, 'open');
  const subscription = { type: 'subscribe', topic: 'conversation',
    conversationId: 'conversation', since, generation };
  socket.send(JSON.stringify(subscription));
  return { socket, frames };
}
function isNotice(frame: Frame) { return String(frame.type) === 'budget_stop'; }
function isReady(frame: Frame) { return frame.type === 'ready'; }
async function ready(client: Awaited<ReturnType<typeof connect>>) {
  function hasReady() { expect(client.frames.some(isReady)).toBe(true); }
  await vi.waitFor(hasReady, { timeout: 5000 });
}
async function notice(client: Awaited<ReturnType<typeof connect>>) {
  function hasNotice() { expect(client.frames.filter(isNotice)).toHaveLength(1); }
  await vi.waitFor(hasNotice, { timeout: 5000 });
  return client.frames.find(isNotice)!;
}
async function read(sub = 'alice', id = turnId) {
  const request = { url: `/api/conversations/conversation/budget-stops?turnId=${id}`,
    headers: headers(sub) };
  return app.inject(request);
}
async function authorisedDelivery() {
  await setup.append('computer-assistant', 'computer.turn_closed', {
    assistantId: 'assistant', computerId: 'computer', conversationId: 'conversation',
    turnId, requesterId: 'alice', task: 'chat_turn', status: 'completed' });
  await participant();
  turnId = await message();
  await setup.runner.run(conversations);
  const requester = await connect();
  const participantClient = await connect('bob');
  await ready(requester);
  await ready(participantClient);
  const stopId = await stop();
  const numeric = expect.any(Number) as unknown;
  const expected = { version: 1, topic: 'conversation', type: 'budget_stop',
    conversationId: 'conversation', turnId, position: numeric,
    generation: numeric };
  expect(await notice(requester)).toEqual(expected);
  expect(await notice(participantClient)).toEqual(expected);
  const requesterReply = await read();
  expect(requesterReply.json()).toMatchObject({ status: 'stopped', stopId,
    work: [{ turnId, execution: 'not_started' }] });
  const participantReply = await read('bob');
  expect(participantReply.json()).toMatchObject({ status: 'stopped', stopId });
  expect(participantReply.body).not.toMatch(/cents/iu);
  await setup.runner.run(conversations);
  await delay(250);
  expect(requester.frames.filter(isNotice)).toHaveLength(1);
}
it('notifies the requester and participant once, with GET supplying the saved status',
  authorisedDelivery);

async function restrictedHistory() {
  await participant();
  await stop();
  const client = await connect('bob');
  await ready(client);
  expect(client.frames.filter(isNotice)).toEqual([]);
  function revealsTurn(frame: Frame) { return frame.row?.data.turnId === turnId; }
  expect(client.frames.some(revealsTurn)).toBe(false);
  expect((await read('bob')).statusCode).toBe(403);
}
it('does not notify a late participant about a turn before their visible history', restrictedHistory);

const losses = ['participant', 'member', 'silo'] as const;
async function revokedDuringLoad(loss: typeof losses[number]) {
  const client = await connect();
  await ready(client);
  const original = setup.db.query.bind(setup.db);
  const gate = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  async function query<Row extends Record<string, unknown>>(sql: string, values?: unknown[]) {
    const result = await original<Row>(sql, values);
    if (sql.startsWith('SELECT * FROM conversation_feed')) {
      entered.resolve();
      await gate.promise;
    }
    return result;
  }
  vi.spyOn(setup.db, 'query').mockImplementation(query);
  try {
    await stop();
    await entered.promise;
    const closed = once(client.socket, 'close');
    if (loss === 'silo') {
      setup.binding.silo = 'foreign';
    } else if (loss === 'member') {
      await setup.append('member-alice', 'member.removed', {
        memberId: 'alice', removedBy: 'alice' });
    } else {
      await setup.append('participation-conversation', 'participant.removed', {
        conversationId: 'conversation', participantId: 'alice', removedBy: 'alice' });
    }
    await closed;
    gate.resolve();
    await delay(200);
    expect(client.frames.filter(isNotice)).toEqual([]);
    expect((await read()).statusCode).toBe(403);
  } finally {
    gate.resolve();
  }
}
it.each(losses)('drops a late protected frame after %s access is lost', revokedDuringLoad);

async function slowHistory() {
  const client = await connect();
  await ready(client);
  const original = setup.db.query.bind(setup.db);
  let delayed = false;
  async function query<Row extends Record<string, unknown>>(sql: string, values?: unknown[]) {
    if (sql.startsWith('SELECT * FROM conversation_feed') && !delayed) {
      delayed = true;
      await delay(2200);
      await message();
    }
    return original<Row>(sql, values);
  }
  vi.spyOn(setup.db, 'query').mockImplementation(query);
  await stop();
  function hasNotice() { expect(client.frames.filter(isNotice)).toHaveLength(1); }
  await vi.waitFor(hasNotice, { timeout: 5000 });
  expect(client.socket.readyState).toBe(WebSocket.OPEN);
  expect((await read()).statusCode).toBe(200);
}
it('keeps a viewer open during slow history and unrelated chat activity', slowHistory);

async function reconnectAndReplay() {
  const first = await connect();
  await ready(first);
  const cursor = first.frames.at(-1)!;
  const closed = once(first.socket, 'close');
  first.socket.close();
  await closed;
  const stopId = await stop();
  const before = await setup.nats.store.head();
  const second = await connect('alice', cursor.position, cursor.generation);
  const savedNotice = await notice(second);
  const response = await read();
  const status = budgetStopStatusSchema.parse(response.json());
  expect(status).toMatchObject({ status: 'stopped', stopId,
    work: [{ turnId, execution: 'not_started' }] });
  const disconnected = once(second.socket, 'close');
  second.socket.close();
  await disconnected;
  const third = await connect('alice', savedNotice.position, savedNotice.generation);
  await ready(third);
  expect(third.frames.filter(isNotice)).toEqual([]);
  const closedThird = once(third.socket, 'close');
  third.socket.close();
  await closedThird;
  await setup.runner.rebuild(conversations);
  expect((await read()).json()).toEqual(status);
  expect(await setup.nats.store.head()).toBe(before);
  expect(setup.received()).toBe(0);
}
it('recovers the original stop through GET after disconnect and effect-free replay',
  reconnectAndReplay);

async function unavailableData() {
  const client = await connect();
  await ready(client);
  const original = setup.db.query.bind(setup.db);
  async function query<Row extends Record<string, unknown>>(sql: string, values?: unknown[]) {
    if (sql.startsWith('SELECT event_id, position')) throw new Error('Data unavailable');
    return original<Row>(sql, values);
  }
  vi.spyOn(setup.db, 'query').mockImplementation(query);
  const closed = once(client.socket, 'close');
  await stop();
  const [code]: unknown[] = await closed;
  expect(code).toBe(1013);
  expect(client.frames.filter(isNotice)).toEqual([]);
  const readStream = setup.nats.store.readStream.bind(setup.nats.store);
  async function* unavailable(stream: string, from?: number, deadline?: number) {
    if (stream === 'budget-test') throw new Error('Data unavailable');
    yield* readStream(stream, from, deadline);
  }
  vi.spyOn(setup.nats.store, 'readStream').mockImplementation(unavailable);
  const response = await read();
  expect(response.statusCode).toBe(503);
  expect(response.json()).toEqual({ status: 'unavailable' });
}
it('reports a data outage as unavailable without delivering protected status', unavailableData);

async function foreignMember() {
  const binding = await createStore(fga.apiUrl, 'foreign');
  const auth = memberAuthorisation(binding);
  const joined = envelope('foreign', 'member-foreign-reader', 'member.joined', {
    memberId: 'foreign-reader', email: 'foreign@example.test',
    displayName: 'Foreign reader', role: 'owner' });
  const foreign = await natsFixture();
  try {
    await foreign.seed([joined]);
    await auth.handler.handle(joined, setup.db);
    await stop();
    const client = await connect('foreign-reader');
    const [code]: unknown[] = await once(client.socket, 'close');
    expect(code).toBe(1008);
    expect(client.frames.filter(isNotice)).toEqual([]);
    expect((await read('foreign-reader')).statusCode).toBe(403);
  } finally {
    await foreign.close();
  }
}
it('refuses a member registered only in another silo', foreignMember);
