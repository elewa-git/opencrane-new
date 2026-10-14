import { createHash, generateKeyPairSync } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { tokenIssuer } from '@opencrane/auth';
import { until } from '@opencrane/authz/testing';
import { BudgetActor } from '@opencrane/models';
import { createLogger } from '@opencrane/observability';
import { Client } from 'minio/dist/esm/minio.mjs';
import { afterEach, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';
import { bridgeChannel } from '../../computer/src/channel.ts';
import { connectBridge } from '../src/chat/bridge.ts';
import { assistantProcessor } from '../src/chat/bridge-poll.ts';
import type { AgentSession } from '../src/chat/bridge-conversation.ts';
import { chatHistory } from '../src/chat/commands.ts';
import { viewFixture } from './support/view-fixture.ts';

type Frame = Record<string, unknown>;
let fixture: Awaited<ReturnType<typeof budgetBridge>> | undefined;
function noDesktop(): Promise<never> {
  return Promise.reject(new Error('No viewer is needed'));
}
async function cleanup() {
  vi.restoreAllMocks();
  await fixture?.close();
  fixture = undefined;
}
afterEach(cleanup);

async function budgetBridge(realChannel = false) {
  const view = await viewFixture(noDesktop);
  const directory = await mkdtemp(`${tmpdir()}/budget-bridge-`);
  const keyOptions = { namedCurve: 'P-256',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' } } as const;
  const key = generateKeyPairSync('ec', keyOptions);
  const privateKeyPath = `${directory}/key.pem`;
  await writeFile(privateKeyPath, key.privateKey, { mode: 0o600 });
  const issuerOptions = { privateKeyPath, issuer: 'https://bridge.test/' };
  const tokens = await tokenIssuer(issuerOptions);
  const actor = new BudgetActor(view.nats.store, 'test');
  await actor.start(2000, 20000, 'personal');
  const assistantId = realChannel ? 'team-assistant' : 'assistant';
  const kind = realChannel ? 'team' : 'personal';
  if (realChannel) {
    const assistant = { assistantId, ownerId: 'team', kind, payingGroupId: 'payer-a' };
    await view.append(`assistant-${assistantId}`, 'assistant.created', assistant);
    const claim = { assistantId, computerId: 'desktop', sandboxUid: 'sandbox',
      generation: 1, tokenId: 'token:test' };
    await view.append(`computer-${assistantId}`, 'computer.claimed', claim);
    const ready = { assistantId, computerId: 'desktop', generation: 1, podUid: 'fixture' };
    await view.append(`computer-${assistantId}`, 'computer.ready', ready);
  }
  const server = createServer();
  const frames: Frame[] = [];
  const interrupts: unknown[] = [];
  const grants: unknown[] = [];
  let threadCount = 0;
  function grant(value: unknown) {
    grants.push(value);
    return Promise.resolve();
  }
  function credential() {
    return { value: 'test', expiresAt: Date.now() + 60_000 };
  }
  function rpc(method: string, input: Frame) {
    if (method === 'thread/start') {
      threadCount++;
      return Promise.resolve({ thread: { id: `thread-${threadCount}` } });
    }
    if (method === 'turn/interrupt') interrupts.push(input);
    return Promise.resolve({ turn: { id: `codex-${String(input['threadId'])}` } });
  }
  const driver = { rpc, grant, credential, journal: `${directory}/reports` };
  const channel = realChannel ? bridgeChannel(server, driver) : undefined;
  const socketOptions = { server };
  const computers = realChannel ? undefined : new WebSocketServer(socketOptions);
  function connected(socket: WebSocket) {
    function receive(bytes: Buffer) {
      const frame = z.record(z.string(), z.unknown()).parse(JSON.parse(bytes.toString()));
      frames.push(frame);
      if (frame['type'] === 'file_end') {
        const receipt = { type: 'file_received', fileId: 'upload', sha256 };
        socket.send(JSON.stringify(receipt));
      }
    }
    socket.on('message', receive);
  }
  computers?.on('connection', connected);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing bridge port');
  const options = { ...view, store: view.nats.store, silo: 'test' };
  const input = { url: `ws://127.0.0.1:${address.port}/bridge`,
    computerId: 'desktop', assistantId, bearer: 'test' };
  let link = { ...await connectBridge(options, input, tokens), connectionId: 1 };
  if (realChannel) {
    const send = link.socket.send.bind(link.socket);
    function recordSend(data: Parameters<typeof send>[0]) {
      if (typeof data !== 'string') throw new Error('Expected a text bridge frame');
      const frame = z.record(z.string(), z.unknown()).parse(JSON.parse(data));
      frames.push(frame);
      send(data);
    }
    vi.spyOn(link.socket, 'send').mockImplementation(recordSend);
  }
  const objectOptions = { endPoint: '127.0.0.1', useSSL: false };
  const objects = new Client(objectOptions);
  const bytes = Buffer.from('file contents');
  const hash = createHash('sha256');
  const sha256 = hash.update(bytes).digest('hex');
  function readObject() {
    return Promise.resolve(Readable.from([bytes]));
  }
  vi.spyOn(objects, 'getObject').mockImplementation(readObject);
  let connectionGate: Promise<void> | undefined;
  let connectionEntered: (() => void) | undefined;
  async function connection() {
    connectionEntered?.();
    await connectionGate;
    return link;
  }
  function pauseConnection() {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    connectionGate = release.promise;
    connectionEntered = entered.resolve;
    return { entered: entered.promise, release: release.resolve };
  }
  function connectionId() {
    return link.connectionId;
  }
  const watchOptions = { ...options, objects };
  const processor = assistantProcessor(watchOptions, tokens, new Set(), connection,
    connectionId, createLogger('budget-bridge-test'));
  const sessions: AgentSession[] = [];
  async function message(conversationId: string, payer = 'personal') {
    const created = { conversationId, assistantId, createdBy: 'alice',
      mode: 'agent_session', payingGroupId: payer };
    await view.append(`conversation-${conversationId}`, 'conversation.created', created);
    view.keys.provision('test', conversationId);
    const encrypted = view.keys.encrypt('test', conversationId, 'Keep working');
    const posted = { conversationId, authorId: 'alice', authorKind: 'human',
      contentType: 'text', executionMode: 'memory_free', ...encrypted };
    const saved = await view.append(`conversation-${conversationId}`, 'message.posted', posted);
    const session: AgentSession = { conversationId, assistantId, createdBy: 'alice',
      mode: 'agent_session', createdAt: saved.time, assistantKind: kind };
    sessions.push(session);
    return { conversationId, turnId: saved.id };
  }
  type Turn = Awaited<ReturnType<typeof message>>;
  async function start(turn: Turn, payer = 'personal', threadId = 'thread-1') {
    const started = { ...turn, assistantId, threadId };
    await view.append(`conversation-${turn.conversationId}`, 'agent.turn_started', started);
    const admitted = { ...started, requesterId: 'alice', computerId: 'desktop',
      task: 'chat_turn', payingGroupId: payer, executionMode: 'memory_free' };
    await view.append(`computer-${assistantId}`, 'computer.turn_started', admitted);
  }
  async function stop(turn: Turn, stopId = 'first-stop') {
    const stopped = { ...turn, reason: 'budget', stopId };
    await view.append(`conversation-${turn.conversationId}`, 'agent.turn_stop_requested', stopped);
  }
  async function process(conversationId?: string) {
    function selected(session: AgentSession) {
      return conversationId === undefined || session.conversationId === conversationId;
    }
    const selectedSessions = sessions.filter(selected);
    await processor.processAssistant(selectedSessions);
    const pong = once(link.socket, 'pong');
    link.socket.ping();
    await pong;
  }
  async function reconnect() {
    link.socket.terminate();
    await once(link.socket, 'close');
    await link.settled();
    link = { ...await connectBridge(options, input, tokens), connectionId: 2 };
    frames.length = 0;
  }
  async function upload(turn: Turn) {
    const uploaded = { conversationId: turn.conversationId, fileId: 'upload',
      uploadedBy: 'alice', name: 'upload.txt', size: bytes.length, sha256, mime: 'text/plain',
      objectKey: `test/${turn.conversationId}/upload` };
    await view.append(`conversation-${turn.conversationId}`, 'file.uploaded', uploaded);
  }
  async function close() {
    link.socket.terminate();
    for (const socket of computers?.clients ?? []) socket.terminate();
    await link.settled();
    await channel?.close();
    computers?.close();
    server.close();
    await view.close();
    await rm(directory, { recursive: true, force: true });
  }
  return { ...options, actor, assistantId, frames, interrupts, grants, channel, objects, bytes,
    message, start, stop, process, reconnect, pauseConnection, upload, close };
}

function isStop(frame: Frame) {
  return frame['type'] === 'stop';
}
function isTurn(frame: Frame) {
  return frame['type'] === 'turn';
}
function isWork(frame: Frame) {
  return frame['type'] !== 'resume';
}
function isSavedStop(row: Awaited<ReturnType<typeof chatHistory>>[number]) {
  return row.event.type === 'agent.turn_stop_requested';
}

async function stopBeforeUpload() {
  fixture = await budgetBridge();
  const turn = await fixture.message('first');
  await fixture.start(turn);
  await fixture.stop(turn);
  await fixture.upload(turn);
  await fixture.process();
  const work = fixture.frames.filter(isWork);
  expect(work[0]).toEqual({ type: 'stop', ...turn, reason: 'budget', stopId: 'first-stop' });
  expect(fixture.frames.filter(isTurn)).toEqual([]);
  expect(work).toContainEqual(expect.objectContaining({ type: 'file_begin' }));
}
it('sends the saved budget Stop before uploads and never redelivers its started turn', stopBeforeUpload);

async function neverResendsStoppedWork(delivered: boolean) {
  fixture = await budgetBridge();
  const turn = await fixture.message('first');
  if (delivered) await fixture.process();
  fixture.frames.length = 0;
  await fixture.stop(turn);
  const limit = { scope: 'global' as const, ceilingCents: 100000, setBy: 'alice' };
  await fixture.actor.configure(limit);
  await fixture.process();
  await fixture.process();
  expect(fixture.frames.filter(isTurn)).toEqual([]);
  if (delivered) expect(fixture.frames.filter(isStop)).toHaveLength(1);
  await fixture.reconnect();
  await fixture.process();
  expect(fixture.frames.filter(isTurn)).toEqual([]);
}
it.each([false, true])('never sends stopped queued work after recovery (delivered: %s)',
  neverResendsStoppedWork);

async function retriesUntilTerminal(terminal: string) {
  fixture = await budgetBridge();
  const turn = await fixture.message('first');
  await fixture.start(turn);
  await fixture.stop(turn);
  await fixture.process();
  expect(fixture.frames.filter(isStop)).toHaveLength(1);
  await fixture.process();
  await delay(600);
  await fixture.process();
  expect(fixture.frames.filter(isStop)).toHaveLength(1);
  await delay(450);
  await fixture.process();
  expect(fixture.frames.filter(isStop)).toHaveLength(2);
  await fixture.reconnect();
  await fixture.process();
  expect(fixture.frames.filter(isWork)[0]).toEqual({
    type: 'stop', ...turn, reason: 'budget', stopId: 'first-stop',
  });
  expect(fixture.frames.filter(isTurn)).toEqual([]);
  const subject = terminal === 'computer.turn_closed'
    ? `computer-${fixture.assistantId}` : 'conversation-first';
  let data: Frame = turn;
  if (terminal === 'computer.turn_closed') {
    data = { ...turn, assistantId: fixture.assistantId, computerId: 'desktop',
      requesterId: 'alice', task: 'chat_turn', status: 'completed' };
  } else if (terminal === 'agent.turn_failed') {
    data = { ...turn, reason: 'bridge_interrupted' };
  }
  await fixture.append(subject, terminal, data);
  fixture.frames.length = 0;
  await delay(1050);
  await fixture.process();
  expect(fixture.frames.filter(isWork)).toEqual([]);
  const rows = await chatHistory(fixture.store, 'test', 'first');
  expect(rows.filter(isSavedStop)).toHaveLength(1);
}
it.each(['agent.turn_completed', 'agent.turn_failed', 'computer.turn_closed'])(
  'retries a lost Stop at least a second apart and on reconnect until %s', retriesUntilTerminal);

async function firstSavedReference() {
  fixture = await budgetBridge();
  const turn = await fixture.message('first');
  await fixture.start(turn);
  await fixture.stop(turn);
  await fixture.stop(turn, 'later-stop');
  const reads = vi.spyOn(fixture.store, 'readStream');
  await fixture.process();
  function budgetRead(call: typeof reads.mock.calls[number]) {
    return call[0] === 'budget-test';
  }
  function chatRead(call: typeof reads.mock.calls[number]) {
    return call[0] === 'conversation-first';
  }
  expect(reads.mock.calls.filter(budgetRead)).toEqual([]);
  expect(reads.mock.calls.filter(chatRead)).toHaveLength(1);
  expect(fixture.frames.filter(isStop)).toEqual([
    { type: 'stop', ...turn, reason: 'budget', stopId: 'first-stop' },
  ]);
}
it('uses only the first saved budget reference and the exact safe frame fields', firstSavedReference);

async function isolatesRealTurns() {
  fixture = await budgetBridge(true);
  const test = fixture;
  const first = await test.message('first', 'payer-a');
  const second = await test.message('second', 'payer-b');
  await test.start(first, 'payer-a', 'thread-1');
  await test.start(second, 'payer-b', 'thread-2');
  // Replay saved admissions with their original payers on the shared computer.
  await test.process('first');
  function firstGranted() {
    return test.grants.length === 1;
  }
  await until(firstGranted);
  await test.process('second');
  function bothGranted() {
    return test.grants.length === 2;
  }
  await until(bothGranted);
  await test.stop(first);
  test.frames.length = 0;
  await test.process();
  function interrupted() {
    return test.interrupts.length > 0;
  }
  await until(interrupted);
  expect(test.interrupts).toEqual([{ threadId: 'thread-1', turnId: 'codex-thread-1' }]);
  expect(test.frames.filter(isStop)).toEqual([
    { type: 'stop', ...first, reason: 'budget', stopId: 'first-stop' },
  ]);
  expect(test.frames.filter(isTurn)).toEqual([]);
  await test.channel!.renew('thread-2');
  expect(test.grants).toEqual(['thread-1', 'thread-2', 'thread-2']);
  function secondAcknowledgement(frame: Frame) {
    return frame['type'] === 'ack' && frame['sequence'] === 2;
  }
  const acknowledgement = test.frames.find(secondAcknowledgement);
  expect(typeof acknowledgement?.['token']).toBe('string');
  expect(acknowledgement?.['expiresAt']).toBeGreaterThan(Date.now());
  expect(acknowledgement?.['refused']).toBeUndefined();
  const completion = { method: 'turn/completed',
    params: { threadId: 'thread-2', turn: { status: 'completed' } } };
  test.channel!.notification(completion);
  async function secondCompleted() {
    const rows = await chatHistory(test.store, 'test', 'second');
    function completed(row: typeof rows[number]) {
      return row.event.type === 'agent.turn_completed';
    }
    return rows.some(completed);
  }
  await until(secondCompleted);
  const rows = await chatHistory(test.store, 'test', 'second');
  expect(rows.filter(isSavedStop)).toEqual([]);
}
it('interrupts only the stopped payer on the real team computer channel', isolatesRealTurns);

async function stopDuringReconnect() {
  fixture = await budgetBridge();
  const turn = await fixture.message('first');
  await fixture.start(turn);
  await fixture.process();
  expect(fixture.frames.filter(isTurn)).toHaveLength(1);
  // Force another conversation pass while the replacement connection is still opening.
  await fixture.upload(turn);
  const gate = fixture.pauseConnection();
  const processing = fixture.process();
  try {
    await gate.entered;
    await fixture.stop(turn);
    await fixture.reconnect();
  } finally {
    gate.release();
    await processing;
  }
  const work = fixture.frames.filter(isWork);
  expect.soft(work[0]).toEqual({ type: 'stop', ...turn, reason: 'budget', stopId: 'first-stop' });
  expect(fixture.frames.filter(isTurn)).toEqual([]);
}
it('sends a Stop saved while reconnect opens before releasing work on the new socket',
  stopDuringReconnect);

async function stopDuringPreparation(wait: string) {
  fixture = await budgetBridge();
  const turn = await fixture.message('first');
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  if (wait === 'object read') {
    await fixture.upload(turn);
    const bytes = fixture.bytes;
    async function pausedObjectRead() {
      entered.resolve();
      await release.promise;
      return Readable.from([bytes]);
    }
    vi.spyOn(fixture.objects, 'getObject').mockImplementation(pausedObjectRead);
  } else {
    const read = fixture.store.readStream.bind(fixture.store);
    async function* pausedMembershipRead(subject: string, from?: number, deadline?: number) {
      if (subject === 'member-alice') {
        entered.resolve();
        await release.promise;
      }
      yield* read(subject, from, deadline);
    }
    vi.spyOn(fixture.store, 'readStream').mockImplementation(pausedMembershipRead);
  }
  const processing = fixture.process();
  try {
    await entered.promise;
    await fixture.stop(turn);
  } finally {
    release.resolve();
    await processing;
  }
  expect(fixture.frames.filter(isWork)[0]).toEqual({
    type: 'stop', ...turn, reason: 'budget', stopId: 'first-stop',
  });
  expect(fixture.frames.filter(isTurn)).toEqual([]);
}
it.each(['object read', 'membership read'])(
  'sends a Stop saved during %s before releasing the prepared work', stopDuringPreparation);
