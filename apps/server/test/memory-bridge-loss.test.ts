import { once } from 'node:events';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { WebSocketServer, type RawData } from 'ws';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createEventStore } from '@opencrane/event-store';
import { event, natsFixture } from '@opencrane/event-store/testing';
import { memoryContextRecordedEventSchema } from '@opencrane/events';
import { until } from '@opencrane/authz/testing';
import { connectBridge } from '../src/chat/bridge.ts';
import { chatCommand, chatHistory } from '../src/chat/commands.ts';
import { conversationKeys } from '../src/chat/keys.ts';

let nats: Awaited<ReturnType<typeof natsFixture>>;
let keys: ReturnType<typeof conversationKeys>;
let sockets: WebSocketServer;
let link: Awaited<ReturnType<typeof connectBridge>>;
let peer: import('ws').WebSocket;
let replies: unknown[];
let url: string;
const canary = 'Private bridge reply canary';
const context = { silo: 'test', computerId: 'computer', assistantId: 'assistant' };

function receive(raw: RawData) {
  if (!Buffer.isBuffer(raw)) throw new Error('Unexpected test frame');
  const reply: unknown = JSON.parse(raw.toString());
  replies.push(reply);
}
async function connect() {
  const connected = once(sockets, 'connection');
  const options = { ...context, store: nats.store, keys };
  const input = { ...context, url, bearer: 'test' };
  link = await connectBridge(options, input);
  await connected;
  peer = [...sockets.clients][0]!;
  peer.on('message', receive);
}
async function prepare() {
  replies = [];
  nats = await natsFixture();
  keys = conversationKeys(`${dirname(nats.env().NATS_CA_FILE)}/keys`);
  for (const memberId of ['alice', 'bob']) {
    keys.provision('test', memberId);
    const owner = { silo: 'test', memberId };
    const creation = { id: `create-${memberId}`, conversationId: memberId,
      assistantId: 'assistant' };
    await chatCommand(nats.store, keys, owner, creation);
    const message = { id: `turn-${memberId}`, conversationId: memberId,
      text: `${memberId} independent question` };
    await chatCommand(nats.store, keys, owner, message);
  }
  const data = { conversationId: 'alice', turnId: 'turn-alice', requesterId: 'alice',
    assistantId: 'assistant', computerId: 'computer', generation: 1, threadId: 'thread',
    inputGeneration: 'input', projectionGeneration: '1', action: 'prepared', delivery: null,
    callDigest: null, dispatchDigest: null, additions: [], scopePositions: [],
    byteCount: 0, hasOmissions: false, reason: 'none' };
  const saved = { ...event('memory', 'conversation-alice', 'agent.memory_context_recorded'),
    source: 'opencrane-server', data };
  await nats.seed([memoryContextRecordedEventSchema.parse(saved)]);
  sockets = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(sockets, 'listening');
  const address = sockets.address();
  if (!address || typeof address === 'string') throw new Error('Missing test address');
  url = `ws://127.0.0.1:${address.port}`;
  await connect();
}
async function close() {
  vi.restoreAllMocks();
  link?.socket.terminate();
  peer?.terminate();
  await link?.settled();
  sockets?.close();
  await nats?.close();
}
beforeEach(prepare);
afterEach(close);

function report(type = 'agent.message_delta', sequence = 1, memberId = 'alice') {
  return { sequence, previousSequence: sequence - 1, conversationId: memberId,
    turnId: `turn-${memberId}`, assistantId: 'assistant', requesterId: memberId,
    messageId: 'reply', type, text: canary };
}
async function send(value: ReturnType<typeof report>) {
  const previous = replies.length;
  peer.send(JSON.stringify(value));
  function replied() {
    return replies.length > previous || link.socket.readyState === link.socket.CLOSED;
  }
  await until(replied, 5000);
  expect(link.rejection).toBeUndefined();
  expect(replies.at(-1)).toEqual({ type: 'ack', sequence: value.sequence });
}
function hasReport(row: Awaited<ReturnType<typeof chatHistory>>[number]) {
  return row.event.report !== undefined;
}
async function savedReports() {
  const cold = await createEventStore(nats.connection);
  const rows = await chatHistory(cold, 'test', 'alice');
  return rows.filter(hasReport);
}
async function acknowledgesUnavailableOutput() {
  const value = report();
  await send(value);
  await send(value);
  const saved = await savedReports();
  expect(saved).toHaveLength(1);
  expect(saved[0]?.event.type).toBe('agent.output_lost');
  expect(saved[0]?.event.data).toEqual({ conversationId: 'alice', turnId: 'turn-alice' });
  const hash = createHash('sha256');
  hash.update(JSON.stringify(value));
  expect(JSON.stringify(saved)).not.toContain(hash.digest('hex'));
  expect(JSON.stringify([saved, replies])).not.toMatch(/ciphertext|Private bridge reply canary/u);
}
it('acknowledges private output and duplicate reports with one text-free unavailable record',
  acknowledgesUnavailableOutput);
