import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { WebSocketServer, type WebSocket } from 'ws';
import { expect, it, vi } from 'vitest';
import { natsFixture } from '@opencrane/event-store/testing';
import { until } from '@opencrane/authz/testing';
import { connectBridge } from '../src/chat/bridge.ts';
import { conversationKeys } from '../src/chat/keys.ts';
import { chatCommand } from '../src/chat/commands.ts';
import { reportPosition } from '../src/chat/reports.ts';

async function keepsAcceptedReports() {
  const nats = await natsFixture();
  const directory = await mkdtemp(`${tmpdir()}/bridge-pressure-recovery-`);
  const keys = conversationKeys(directory);
  const server = createServer();
  const sockets = new WebSocketServer({ server });
  keys.provision('test', 'chat');
  const owner = { silo: 'test', memberId: 'alice' };
  const creation = { id: 'create', conversationId: 'chat', assistantId: 'assistant' };
  await chatCommand(nats.store, keys, owner, creation);
  const message = { id: 'message', conversationId: 'chat', text: 'Hello' };
  await chatCommand(nats.store, keys, owner, message);
  let release!: () => void;
  function hold(resolve: () => void) { release = resolve; }
  const gate = new Promise<void>(hold);
  let writing = false;
  const append = nats.store.append.bind(nats.store);
  async function delayedAppend(command: Parameters<typeof append>[0]) {
    writing = true;
    await gate;
    return append(command);
  }
  vi.spyOn(nats.store, 'append').mockImplementation(delayedAppend);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No listener');
  const options = { silo: 'test', store: nats.store, keys };
  const input = { url: `ws://127.0.0.1:${address.port}`, computerId: 'computer',
    assistantId: 'assistant', bearer: 'test' };
  function peer(resolve: (socket: WebSocket) => void) { sockets.once('connection', resolve); }
  const connected = new Promise<WebSocket>(peer);
  const link = await connectBridge(options, input);
  const socket = await connected;
  function report(sequence: number) {
    return JSON.stringify({ sequence, previousSequence: sequence - 1,
      conversationId: 'chat', turnId: 'message', assistantId: 'assistant',
      type: 'agent.message_delta', messageId: 'reply', text: 'A city. ' });
  }
  function hasStartedWriting() { return writing; }
  function closedSocket(resolve: (result: { code: number; reason: string }) => void) {
    function closed(code: number, reason: Buffer) {
      resolve({ code, reason: reason.toString() });
    }
    socket.once('close', closed);
  }
  try {
    socket.send(report(1));
    await until(hasStartedWriting, 1000);
    const closed = new Promise(closedSocket);
    for (let sequence = 2; sequence <= 100; sequence++) socket.send(report(sequence));
    const { code, reason } = await closed;
    expect(code).toBe(1013);
    expect(reason).toBe('Report queue limit');
    release();
    await link.settled();
    // Keep the accepted batch so the next connection resumes beyond it.
    expect(await reportPosition(nats.store, 'test', 'computer')).toBe(64);
  } finally {
    release();
    link.socket.terminate();
    socket.terminate();
    await link.settled();
    function closeSockets(resolve: () => void) { sockets.close(resolve); }
    await new Promise<void>(closeSockets);
    server.close();
    await nats.close();
    await rm(directory, { recursive: true, force: true });
  }
}

it('saves accepted reports after overflow closes the socket so replay can advance',
  keepsAcceptedReports);
