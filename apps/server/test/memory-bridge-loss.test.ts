import { once } from 'node:events';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { WebSocketServer, type RawData } from 'ws';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createEventStore, type EventStore } from '@opencrane/event-store';
import { event, natsFixture } from '@opencrane/event-store/testing';
import { memoryContextRecordedEventSchema } from '@opencrane/events';
import { databases, until } from '@opencrane/authz/testing';
import { conversations, pgDb, ProjectionRunner, readConversation } from '@opencrane/projections';
import { createLogger } from '@opencrane/observability';
import { connectBridge } from '../src/chat/bridge.ts';
import { chatCommand, chatHistory } from '../src/chat/commands.ts';
import { conversationKeys } from '../src/chat/keys.ts';
import { recordBridgeReports, reportPosition } from '../src/chat/reports.ts';

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
  if (!Buffer.isBuffer(raw)) {
    throw new Error('Unexpected test frame');
  }
  const reply: unknown = JSON.parse(raw.toString());
  replies.push(reply);
}
async function connect(store: EventStore = nats.store) {
  const connected = once(sockets, 'connection');
  const options = { ...context, store, keys };
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
  if (!address || typeof address === 'string') {
    throw new Error('Missing test address');
  }
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
    const reply = replies.at(-1);
    const acknowledged = replies.length > previous && reply !== null &&
      typeof reply === 'object' && 'type' in reply && reply.type === 'ack';
    return acknowledged || link.socket.readyState === link.socket.CLOSED;
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

async function losesEveryMemoryState(action: 'loaded' | 'invalidated' | 'ended') {
  const rows = await chatHistory(nats.store, 'test', 'alice');
  const prepared = memoryContextRecordedEventSchema.parse(rows.at(-1)!.event);
  const data = { ...prepared.data, action };
  if (action === 'loaded') {
    data.delivery = 'initial';
  }
  if (action === 'invalidated') {
    data.reason = 'content_changed';
  }
  if (action === 'ended') {
    data.reason = 'ended';
  }
  const saved = { ...prepared, id: action, commandId: action, data };
  await nats.seed([memoryContextRecordedEventSchema.parse(saved)]);
  await send(report('agent.message_completed'));
  await send(report('agent.reasoning_summarised', 2));
  const reports = await savedReports();
  expect(reports).toHaveLength(2);
  for (const row of reports) {
    expect(row.event.type).toBe('agent.output_lost');
  }
  expect(JSON.stringify(reports)).not.toMatch(/ciphertext|Private bridge reply canary/u);
}
it.each(['loaded', 'invalidated', 'ended'] as const)(
  'records only unavailable output for %s memory', losesEveryMemoryState);

async function recoversLostAcknowledgement() {
  const append = nats.store.append.bind(nats.store);
  async function loseAcknowledgement(command: Parameters<typeof append>[0]): Promise<never> {
    await append(command);
    throw new Error('Test loses acknowledgement');
  }
  vi.spyOn(nats.store, 'append').mockImplementationOnce(loseAcknowledgement);
  const closed = once(peer, 'close');
  peer.send(JSON.stringify(report()));
  expect((await closed)[0]).toBe(1011);
  await link.settled();
  const cold = await createEventStore(nats.connection);
  await connect(cold);
  await send(report());
  const changed = { ...report(), text: 'Different discarded text' };
  await send(changed);
  expect(await savedReports()).toHaveLength(1);
  expect(await reportPosition(cold, 'test', 'computer')).toBe(1);
  expect(JSON.stringify(replies)).not.toMatch(/Private bridge reply canary|Different discarded/u);
}
it('reconciles an uncertain save after reconnect without remembering or hashing private bytes',
  recoversLostAcknowledgement);

async function keepsOtherRequesterDurable() {
  await send(report());
  const bob = { ...report('agent.message_completed', 2, 'bob'), previousSequence: 0,
    text: 'Bob memory-free answer' };
  await send(bob);
  const rows = await chatHistory(nats.store, 'test', 'bob');
  const saved = rows.filter(hasReport);
  expect(keys.decrypt('test', 'bob', saved[0]!.event.data)).toBe('Bob memory-free answer');
  const alice = await chatHistory(nats.store, 'test', 'alice');
  expect(keys.decrypt('test', 'alice', alice[1]!.event.data)).toBe('alice independent question');
  expect(keys.decrypt('test', 'bob', rows[1]!.event.data)).toBe('bob independent question');
  const storage = await databases();
  try {
    const db = pgDb(storage.queue);
    let logs = '';
    function write(line: string) {
      logs += line;
    }
    const loggerOptions = { level: 'info', destination: { write } };
    const logger = createLogger('private-output-projection', loggerOptions);
    const runner = new ProjectionRunner(db, nats.reader, logger);
    await runner.initialise(conversations);
    await runner.run(conversations);
    await runner.rebuild(conversations);
    const projected = await readConversation(db, 'test', 'alice');
    expect(projected.rows.at(-1)).toMatchObject({ type: 'agent.output_lost',
      data: { conversationId: 'alice', turnId: 'turn-alice' } });
    const serialised = JSON.stringify(projected);
    expect(serialised).not.toContain(canary);
    const hash = createHash('sha256');
    hash.update(canary);
    expect(serialised).not.toContain(hash.digest('hex'));
    expect(logs).not.toContain(canary);
  } finally {
    await storage.close();
  }
}
it('keeps human messages and another requester’s memory-free reply durable after projection replay',
  keepsOtherRequesterDurable);

async function consumesQueuedBatchAfterLoss() {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const append = nats.store.append.bind(nats.store);
  async function hold(command: Parameters<typeof append>[0]) {
    entered.resolve();
    await release.promise;
    return append(command);
  }
  vi.spyOn(nats.store, 'append').mockImplementationOnce(hold);
  try {
    peer.send(JSON.stringify(report()));
    await entered.promise;
    for (let sequence = 2; sequence <= 4; sequence++) {
      peer.send(JSON.stringify(report('agent.message_delta', sequence)));
    }
    const closed = once(peer, 'close');
    peer.close();
    await closed;
    release.resolve();
    await link.settled();
    const cold = await createEventStore(nats.connection);
    expect(await reportPosition(cold, 'test', 'computer')).toBe(4);
    await connect(cold);
    for (let sequence = 1; sequence <= 4; sequence++) {
      await send(report('agent.message_delta', sequence));
    }
    const saved = await savedReports();
    expect(saved).toHaveLength(4);
    expect(JSON.stringify(saved)).not.toMatch(/ciphertext|Private bridge reply canary/u);
  } finally {
    release.resolve();
  }
}
it('consumes queued private deltas after socket loss and only restores unavailable records',
  consumesQueuedBatchAfterLoss);

async function refusesInvalidReports() {
  const mismatches = [
    { ...report(), requesterId: 'bob' },
    { ...report(), assistantId: 'other' },
    { ...report(), previousSequence: 2 },
    { ...report('agent.turn_completed') },
    { ...report(), commandDigest: 'a'.repeat(64) },
  ];
  for (const invalid of mismatches) {
    await expect(recordBridgeReports(nats.store, keys, context, [invalid])).rejects.toThrow();
  }
  expect(await savedReports()).toEqual([]);
}
it('keeps identity, ordering, terminal-text and command-hash refusals', refusesInvalidReports);

async function recoversPartlySavedBatch() {
  const values = [report(), report('agent.message_delta', 2), report('agent.message_delta', 3)];
  const append = nats.store.append.bind(nats.store);
  let calls = 0;
  async function loseSecondAcknowledgement(command: Parameters<typeof append>[0]) {
    const saved = await append(command);
    calls++;
    if (calls === 2) {
      throw new Error('Test loses second acknowledgement');
    }
    return saved;
  }
  vi.spyOn(nats.store, 'append').mockImplementation(loseSecondAcknowledgement);
  await expect(recordBridgeReports(nats.store, keys, context, values))
    .rejects.toThrow('Test loses second acknowledgement');
  const cold = await createEventStore(nats.connection);
  expect(await recordBridgeReports(cold, keys, context, values)).toBe('recorded');
  expect(await recordBridgeReports(cold, keys, context, values)).toBe('duplicate');
  expect(await reportPosition(cold, 'test', 'computer')).toBe(3);
  const saved = await savedReports();
  expect(saved).toHaveLength(3);
  expect(JSON.stringify(saved)).not.toMatch(/ciphertext|Private bridge reply canary/u);
}
it('reconciles a partly saved batch without gaps or duplicate loss records', recoversPartlySavedBatch);
