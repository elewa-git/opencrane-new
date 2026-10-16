import { createHash, generateKeyPairSync } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { tokenIssuer } from '@opencrane/auth';
import { until } from '@opencrane/authz/testing';
import { BudgetActor } from '@opencrane/models';
import { createLogger } from '@opencrane/observability';
import { conversations } from '@opencrane/projections';
import { Client } from 'minio/dist/esm/minio.mjs';
import { afterEach, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';
import { SandboxClient } from '../../ops/src/kubernetes.ts';
import { watchBridges } from '../src/chat/bridge.ts';
import { chatHistory } from '../src/chat/commands.ts';
import { viewFixture } from './support/view-fixture.ts';

type Frame = Record<string, unknown>;
type Turn = { conversationId: string; turnId: string };
let fixture: Awaited<ReturnType<typeof budgetWatcher>> | undefined;

function noDesktop(): Promise<never> {
  return Promise.reject(new Error('No viewer is needed'));
}

async function cleanup() {
  await fixture?.close();
  fixture = undefined;
  vi.restoreAllMocks();
}
afterEach(cleanup);

function heldComputer(socket: WebSocket, sha256: string) {
  const frames: { value: Frame; at: number }[] = [];
  const held = Promise.withResolvers<void>();
  let fileId: string | undefined;
  let released = false;
  function receive(bytes: Buffer) {
    const value = z.record(z.string(), z.unknown()).parse(JSON.parse(bytes.toString()));
    const frame = { value, at: performance.now() };
    frames.push(frame);
    if (value['type'] === 'file_begin') fileId = z.string().parse(value['fileId']);
    if (value['type'] === 'file_end') held.resolve();
  }
  socket.on('message', receive);
  function release() {
    if (released || !fileId || socket.readyState !== socket.OPEN) return;
    released = true;
    const receipt = { type: 'file_received', fileId, sha256 };
    socket.send(JSON.stringify(receipt));
  }
  function matching(type: string, conversationId?: string) {
    function matches(frame: typeof frames[number]) {
      return frame.value['type'] === type &&
        (conversationId === undefined || frame.value['conversationId'] === conversationId);
    }
    return frames.filter(matches);
  }
  return { socket, frames, held: held.promise, release, matching,
    get released() { return released; } };
}

async function budgetWatcher() {
  const view = await viewFixture(noDesktop);
  const store = view.nats.store;
  const directory = await mkdtemp(`${tmpdir()}/budget-watcher-`);
  const keyOptions = { namedCurve: 'P-256',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' } } as const;
  const key = generateKeyPairSync('ec', keyOptions);
  const privateKeyPath = `${directory}/key.pem`;
  await writeFile(privateKeyPath, key.privateKey, { mode: 0o600 });
  const issuerOptions = { privateKeyPath, issuer: 'https://bridge.test/' };
  const tokens = await tokenIssuer(issuerOptions);
  const actor = new BudgetActor(store, 'test');
  await actor.start(2000, 20000, 'personal');
  const server = createServer();
  const socketOptions = { server };
  const computers = new WebSocketServer(socketOptions);
  const peers: ReturnType<typeof heldComputer>[] = [];
  const bytes = Buffer.from('file contents');
  const hash = createHash('sha256');
  hash.update(bytes);
  const sha256 = hash.digest('hex');
  function connected(socket: WebSocket) {
    peers.push(heldComputer(socket, sha256));
  }
  computers.on('connection', connected);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing bridge port');
  const proxyUrl = `http://127.0.0.1:${address.port}`;
  const objectOptions = { endPoint: '127.0.0.1', useSSL: false };
  const objects = new Client(objectOptions);
  function readObject() {
    return Promise.resolve(Readable.from([bytes]));
  }
  vi.spyOn(objects, 'getObject').mockImplementation(readObject);
  const kube = new SandboxClient('/unused-test-kubeconfig', 'test');
  vi.spyOn(kube, 'credentials').mockResolvedValue();
  const lines: string[] = [];
  function write(line: string) {
    lines.push(line);
  }
  const loggerOptions = { level: 'error', destination: { write } };
  const logger = createLogger('budget-watcher', loggerOptions);
  const heads = vi.spyOn(store, 'head');
  function isGlobalHead(call: typeof heads.mock.calls[number]) {
    return call[0] === undefined;
  }
  function polls() {
    return heads.mock.calls.filter(isGlobalHead).length;
  }
  async function morePolls() {
    const before = polls();
    function polled() {
      return polls() >= before + 4;
    }
    await until(polled, 3000);
  }
  async function message(conversationId: string) {
    const encrypted = view.keys.encrypt('test', conversationId, 'Keep working');
    const posted = { conversationId, authorId: 'alice', authorKind: 'human',
      contentType: 'text', executionMode: 'memory_free', ...encrypted };
    const saved = await view.append(`conversation-${conversationId}`, 'message.posted', posted);
    return { conversationId, turnId: saved.id };
  }
  async function chat(conversationId: string) {
    const created = { conversationId, assistantId: 'assistant', createdBy: 'alice',
      mode: 'agent_session', payingGroupId: 'personal' };
    await view.append(`conversation-${conversationId}`, 'conversation.created', created);
    view.keys.provision('test', conversationId);
  }
  async function start(turn: Turn) {
    const started = { ...turn, assistantId: 'assistant', threadId: `thread-${turn.conversationId}` };
    await view.append(`conversation-${turn.conversationId}`, 'agent.turn_started', started);
    const admitted = { ...started, requesterId: 'alice', computerId: 'desktop',
      task: 'chat_turn', payingGroupId: 'personal', executionMode: 'memory_free' };
    await view.append('computer-assistant', 'computer.turn_started', admitted);
  }
  async function stop(turn: Turn) {
    const stopped = { ...turn, reason: 'budget', stopId: 'saved-budget-stop' };
    const before = performance.now();
    await view.append(`conversation-${turn.conversationId}`, 'agent.turn_stop_requested', stopped);
    return before;
  }
  async function upload(conversationId: string) {
    const uploaded = { conversationId, fileId: 'upload', uploadedBy: 'alice',
      name: 'upload.txt', size: bytes.length, sha256, mime: 'text/plain',
      objectKey: `test/${conversationId}/upload` };
    await view.append(`conversation-${conversationId}`, 'file.uploaded', uploaded);
  }
  async function project() {
    await view.runner.run(conversations);
  }
  const abort = new AbortController();
  let work: Promise<void> | undefined;
  async function watch() {
    await project();
    const options = { silo: 'test', store, keys: view.keys, db: view.db,
      binding: view.binding, objects };
    work = watchBridges(options, tokens, kube, proxyUrl, abort.signal, logger);
  }
  async function close() {
    abort.abort();
    for (const peer of peers) peer.socket.terminate();
    await work;
    computers.close();
    server.close();
    await view.close();
    await rm(directory, { recursive: true, force: true });
  }
  return { store, peers, lines, message, chat, start, stop, upload, watch, project,
    morePolls, close };
}

async function savedEvents(test: Awaited<ReturnType<typeof budgetWatcher>>,
  conversationId: string, type: string) {
  const rows = await chatHistory(test.store, 'test', conversationId);
  function matches(row: typeof rows[number]) {
    return row.event.type === type;
  }
  return rows.filter(matches);
}

async function expectStop(peer: ReturnType<typeof heldComputer>, turn: Turn, since: number) {
  function arrived() {
    return peer.matching('stop', turn.conversationId).length > 0;
  }
  await until(arrived, Math.max(1, 2000 - (performance.now() - since)));
  const frame = peer.matching('stop', turn.conversationId)[0]!;
  expect(frame.at - since).toBeLessThanOrEqual(2000);
  const expected = { type: 'stop', ...turn, reason: 'budget', stopId: 'saved-budget-stop' };
  expect(frame.value).toEqual(expected);
}

async function stopsDuringUpload(reconnect: boolean, sameChat = false) {
  fixture = await budgetWatcher();
  const test = fixture;
  const stoppedChat = sameChat ? 'first' : 'second';
  await test.chat(stoppedChat);
  const stopped = await test.message(stoppedChat);
  await test.start(stopped);
  await test.watch();
  function started() {
    return test.peers[0]?.matching('turn', stoppedChat).length === 1;
  }
  await until(started);
  let peer = test.peers[0]!;
  peer.frames.length = 0;
  if (!sameChat) await test.chat('first');
  await test.upload('first');
  const waiting = await test.message('first');
  await test.project();
  await peer.held;
  const savedAt = await test.stop(stopped);
  if (reconnect) {
    peer.socket.terminate();
    function resumed() {
      return test.peers[1]?.matching('resume').length === 1;
    }
    await until(resumed);
    peer = test.peers[1]!;
    await peer.held;
    await expectStop(peer, stopped, peer.matching('resume')[0]!.at);
  } else {
    await expectStop(peer, stopped, savedAt);
  }
  await test.morePolls();
  expect(peer.released).toBe(false);
  expect(peer.matching('file_begin')).toHaveLength(1);
  expect(peer.matching('turn')).toEqual([]);
  expect(await savedEvents(test, 'first', 'file.delivered')).toEqual([]);
  peer.release();
  function turnArrived() {
    return peer.matching('turn', 'first').length > 0;
  }
  await until(turnArrived);
  expect(peer.matching('turn', 'first')[0]!.value['id']).toBe(waiting.turnId);
  const deliveries = await savedEvents(test, 'first', 'file.delivered');
  expect(deliveries).toHaveLength(1);
  const expectedDelivery = { fileId: 'upload', computerId: 'desktop' };
  expect(deliveries[0]!.event.data).toMatchObject(expectedDelivery);
  await test.morePolls();
  expect(peer.matching('file_begin')).toHaveLength(1);
  function isStoppedTurn(frame: typeof peer.frames[number]) {
    return frame.value['type'] === 'turn' && frame.value['id'] === stopped.turnId;
  }
  expect(peer.frames.filter(isStoppedTurn)).toEqual([]);
  expect(await savedEvents(test, stoppedChat, 'agent.turn_stop_requested')).toHaveLength(1);
  expect(await savedEvents(test, 'first', 'file.delivered')).toHaveLength(1);
  expect(test.lines.join('')).not.toContain('saved-budget-stop');
}

it.each([false, true])('sends Stop within two seconds with another upload held (reconnect: %s)',
  stopsDuringUpload);

async function sameChatStop() {
  await stopsDuringUpload(false, true);
}
it('sends Stop within two seconds while the same chat holds a later upload', sameChatStop);

async function recoversStopOnly(source: string) {
  fixture = await budgetWatcher();
  const test = fixture;
  await test.chat('second');
  const stopped = await test.message('second');
  await test.start(stopped);
  await test.stop(stopped);
  const read = test.store.readStream.bind(test.store);
  let unavailable = true;
  async function* failHistory(...args: Parameters<typeof read>) {
    if (unavailable && args[0] === `${source}-assistant`) throw new Error('History unavailable');
    yield* read(...args);
  }
  vi.spyOn(test.store, 'readStream').mockImplementation(failHistory);
  await test.watch();
  await test.morePolls();
  expect(test.lines).toHaveLength(1);
  expect(test.peers).toEqual([]);
  const position = await test.store.head();
  unavailable = false;
  function stopArrived() {
    return test.peers[0]?.matching('stop', 'second').length === 1;
  }
  await until(stopArrived, 2000);
  expect(await test.store.head()).toBe(position);
  expect(test.peers[0]!.matching('turn')).toEqual([]);
  expect(await savedEvents(test, 'second', 'agent.turn_stop_requested')).toHaveLength(1);
  expect(test.lines.join('')).not.toContain('saved-budget-stop');
}
it.each(['computer', 'assistant'])(
  'retries a saved Stop without a new event after unreadable %s history recovers', recoversStopOnly);
