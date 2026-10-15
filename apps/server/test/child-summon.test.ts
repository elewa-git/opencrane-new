import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { until } from '@opencrane/authz/testing';
import { listConversations } from '@opencrane/projections';
import { connectBridge } from '../src/chat/bridge.ts';
import { processConversation, assistantSnapshot } from '../src/chat/bridge-conversation.ts';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import { conversations } from '@opencrane/projections';
import { chatHistory } from '../src/chat/commands.ts';
import { summonFixture } from './support/child-summon.ts';

let context: Awaited<ReturnType<typeof summonFixture>>;
async function initialise() { context = await summonFixture(); }
async function close() { await context?.close(); }
beforeAll(initialise, 60_000);
afterAll(close);
afterEach(vi.restoreAllMocks);
async function review(input: Awaited<ReturnType<typeof context.parent>>) {
  const { conversationId, ...payload } = input;
  const response = await context.request(conversationId, 'child-review', payload);
  expect(response.statusCode, response.body).toBe(200);
  return { requestId: input.requestId, sourceMessageId: input.sourceMessageId,
    review: response.json<{ review: string }>().review };
}
async function refusesReview(mode: string, author: string) {
  const input = await context.parent(mode, author);
  const { conversationId, ...payload } = input;
  const before = await context.nats.store.head();
  const response = await context.request(conversationId, 'child-review', payload);
  expect(response.statusCode, response.body).toBe(403);
  expect(await context.nats.store.head()).toBe(before);
}
it.each([['group', 'bob'], ['direct', 'alice'], ['agent_session', 'alice']])(
  'refuses %s parent or %s source without saving', refusesReview);
async function refusesInvalidReview(kind: string) {
  const input = await context.parent();
  if (kind === 'closed') {
    await context.append(`participation-${input.conversationId}`, 'conversation.closed',
      { conversationId: input.conversationId, closedBy: 'alice' }, false);
  }
  if (kind === 'pre-join') {
    await context.append(`participation-${input.conversationId}`, 'participant.removed',
      { conversationId: input.conversationId, participantId: 'alice', removedBy: 'bob' });
    await context.append(`participation-${input.conversationId}`, 'participant.added',
      { conversationId: input.conversationId, participantId: 'alice', addedBy: 'bob' });
  }
  if (kind === 'source') input.sourceMessageId = 'guessed';
  if (kind === 'parent') input.conversationId = 'guessed';
  if (kind === 'assistant') input.assistantId = 'guessed';
  if (kind === 'audience') input.participantIds.push('guessed');
  const { conversationId, ...payload } = input;
  const before = await context.nats.store.head();
  expect((await context.request(conversationId, 'child-review', payload)).statusCode).toBe(403);
  expect(await context.nats.store.head()).toBe(before);
}
it.each(['closed', 'pre-join', 'source', 'parent', 'assistant', 'audience'])(
  'refuses invalid %s review', refusesInvalidReview);
async function refusesSignedReview(kind: string) {
  const input = await context.parent();
  const start = await review(input);
  const before = await context.nats.store.head();
  if (kind === 'tampered') start.review += 'x';
  if (kind === 'expired') vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 600_001);
  const member = kind === 'member' ? 'bob' : 'alice';
  const response = await context.request(input.conversationId, 'children', start, member);
  expect(response.statusCode, response.body).toBe(403);
  expect(await context.nats.store.head()).toBe(before);
}
it.each(['tampered', 'expired', 'member'])('refuses %s signed review', refusesSignedReview);
async function recovers(stage: string) {
  const input = await context.parent();
  const beforeReview = await context.nats.store.head();
  const start = await review(input);
  expect(await context.nats.store.head()).toBe(beforeReview);
  const original = context.nats.store.append.bind(context.nats.store);
  async function loseReply(command: Parameters<typeof original>[0]) {
    const result = await original(command);
    if (command.event.type === 'conversation.created') {
      await context.auth.handler.handle(command.event, context.db);
    }
    if (command.event.type === stage) throw new Error('Lost reply');
    return result;
  }
  const spy = vi.spyOn(context.nats.store, 'append').mockImplementation(loseReply);
  expect((await context.request(input.conversationId, 'children', start)).statusCode).toBe(503);
  spy.mockRestore();
  const saved = await context.intent(input.conversationId);
  const existing = await chatHistory(context.nats.store, 'test', saved.childConversationId);
  await context.restart();
  if (stage === 'message.posted') await delay(120_100);
  let response = await context.request(input.conversationId, 'children', start);
  if (response.statusCode === 425) {
    const rows = await chatHistory(context.nats.store, 'test', saved.childConversationId);
    await context.auth.handler.handle(rows[0]!.event, context.db);
    response = await context.request(input.conversationId, 'children', start);
  }
  expect(response.statusCode, response.body).toBe(202);
  expect(response.json()).toEqual({ requestId: input.requestId, state: 'queued' });
  const rows = await chatHistory(context.nats.store, 'test', saved.childConversationId);
  expect(rows).toHaveLength(2);
  expect(rows.slice(0, existing.length)).toEqual(existing);
  expect(context.keys.decrypt('test', saved.childConversationId, rows[1]!.event.data))
    .toBe('@Assistant source canary');
  const beforeRetry = await context.nats.store.head();
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 600_001);
  expect((await context.request(input.conversationId, 'children', start)).json())
    .toEqual(response.json());
  vi.restoreAllMocks();
  for (const patch of [{ participantIds: ['alice'] }, { allowanceBoundCents: 999 }]) {
    const changed = await review({ ...input, ...patch });
    expect((await context.request(input.conversationId, 'children', changed)).statusCode).toBe(409);
  }
  const otherId = await review({ ...input, requestId: 'other-request' });
  expect((await context.request(input.conversationId, 'children', otherId)).json())
    .toEqual(response.json());
  const status = await context.request(input.conversationId, `children/${input.requestId}`);
  expect(status.json()).toEqual({ requestId: input.requestId, state: 'queued',
    childConversationId: saved.childConversationId });
  const hidden = await context.request(input.conversationId, `children/${input.requestId}`,
    undefined, 'bob');
  const missing = await context.request(input.conversationId, 'children/guessed', undefined, 'bob');
  expect(hidden.json()).toEqual(missing.json());
  expect(status.body).not.toContain('canary');
  await context.runner.rebuild(conversations);
  expect(await context.nats.store.head()).toBe(beforeRetry);
}
it.each(['conversation.child_requested', 'conversation.created', 'message.posted'])(
  'recovers after %s across restart, expiry, changed choices and replay', recovers, 180_000);

async function holdsWork() {
  const input = await context.parent();
  const start = await review(input);
  expect((await context.request(input.conversationId, 'children', start)).statusCode).toBe(425);
  const saved = await context.intent(input.conversationId);
  const rows = await chatHistory(context.nats.store, 'test', saved.childConversationId);
  await context.auth.handler.handle(rows[0]!.event, context.db);
  expect((await context.request(input.conversationId, 'children', start)).statusCode).toBe(202);
  await context.runner.run(conversations);
  const listed = await listConversations(context.db, 'test', 'alice');
  function matches(row: typeof listed[number]) {
    return row.conversationId === saved.childConversationId;
  }
  const child = listed.find(matches)!;
  if (child.mode !== 'agent_session') throw new Error('Expected child');
  const computer = { computerId: 'computer', assistantId: 'helper', generation: 1, podUid: 'test' };
  const ready = await context.append('computer-helper', 'computer.ready', computer, false);
  const before = await context.nats.store.head();
  async function connection(): Promise<never> { throw new Error('Must not deliver'); }
  for (const type of ['computer.ready', 'computer.suspended']) {
    const lifecycle = [{ sequence: before, event: { ...ready, type } }];
    const assistant = assistantSnapshot(lifecycle, 'team', 'test');
    await processConversation(context.options, context.tokens, child, assistant,
      new Set(), connection);
  }
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address();
  if (typeof address === 'string') throw new Error('Expected port');
  const peerPromise = once(server, 'connection');
  const bridge = await connectBridge(context.options, { computerId: 'computer', assistantId: 'helper',
    url: `ws://127.0.0.1:${address.port}`, bearer: 'test' }, context.tokens);
  const [peer] = await peerPromise;
  const received: unknown[] = [];
  function receive(bytes: Buffer) { received.push(JSON.parse(bytes.toString()) as unknown); }
  if (!(peer instanceof WebSocket)) throw new Error('Expected socket');
  peer.on('message', receive);
  try {
    const report = { sequence: 1, previousSequence: 0, type: 'agent.turn_started',
      assistantId: 'helper', conversationId: saved.childConversationId, turnId: saved.firstInputId,
      requesterId: 'alice', executionMode: 'restricted', sharingClass: 'shared_only', threadId: 'thread' };
    peer.send(JSON.stringify(report));
    function finished() { return bridge.rejection !== undefined || received.length > 0; }
    await until(finished);
    await bridge.settled();
    expect(await context.nats.store.head()).toBe(before);
    expect(JSON.stringify(received)).not.toContain('token');
  } finally {
    bridge.socket.terminate();
    for (const client of server.clients) client.terminate();
    server.close();
  }
}
it('holds delivery, resume, admission and tokens for a saved child request', holdsWork);
