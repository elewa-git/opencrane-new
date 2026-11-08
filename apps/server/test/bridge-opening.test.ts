import { createServer } from 'node:http';
import { once } from 'node:events';
import type { Socket } from 'node:net';
import { WebSocket } from 'ws';
import { WebSocketServer } from 'ws';
import { expect, it, vi } from 'vitest';
import { until } from '@opencrane/authz/testing';
import { natsFixture, event } from '@opencrane/event-store/testing';
import { connectBridge } from '../src/chat/bridge.ts';
import { conversationKeys } from '../src/chat/keys.ts';
import { openBridgeSocket } from '../src/chat/bridge-opening.ts';

async function cancelledHandshakeClosesSocket() {
  const server = createServer();
  const accepted = Promise.withResolvers<Socket>();
  function holdUpgrade(_request: unknown, socket: Socket) {
    socket.resume();
    accepted.resolve(socket);
  }
  server.on('upgrade', holdUpgrade);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture unavailable');
  const input = { url: `ws://127.0.0.1:${address.port}/bridge`, computerId: 'computer',
    assistantId: 'assistant', bearer: 'fixture' };
  const control = new AbortController();
  const deadline = performance.now() + 1_000;
  const terminated = vi.spyOn(WebSocket.prototype, 'terminate');
  const opening = openBridgeSocket(input, { signal: control.signal, deadline });
  const remoteSocket = await accepted.promise;
  try {
    control.abort();
    await expect(opening).rejects.toThrow();
    expect(terminated).toHaveBeenCalledTimes(2);
    const clientSocket = terminated.mock.instances[0];
    if (!(clientSocket instanceof WebSocket)) {
      throw new Error('Bridge socket was not terminated');
    }
    await until(() => clientSocket.readyState === WebSocket.CLOSED, 1_000);
    expect(clientSocket.readyState).toBe(WebSocket.CLOSED);
  } finally {
    terminated.mockRestore();
    control.abort();
    remoteSocket.destroy();
    server.close();
  }
}

it('closes a held bridge handshake when routine wake is cancelled',
  cancelledHandshakeClosesSocket);

async function cancelledReportRecoveryDoesNotSaveBudgetRefusal() {
  const nats = await natsFixture();
  const server = createServer();
  const sockets = new WebSocketServer({ server });
  const control = new AbortController();
  const readStarted = Promise.withResolvers<void>();
  const releaseRead = Promise.withResolvers<void>();
  const readFinished = Promise.withResolvers<void>();
  let readFailure: unknown;
  const subject = 'conversation-private';
  const close = { assistantId: 'assistant', computerId: 'computer',
    conversationId: 'private', turnId: 'message', threadId: 'thread',
    requesterId: 'alice', task: 'chat_turn', status: 'failed', budgetStopId: 'stop' };
  const message = { conversationId: 'private', authorId: 'alice', authorKind: 'human',
    contentType: 'text', ciphertext: 'ZmFrZS1jaXBoZXJ0ZXh0', keyId: 'key:1' };
  try {
    const savedClose = { ...event('close', 'computer-assistant', 'computer.turn_closed'),
      data: close };
    const savedMessage = { ...event('message', subject, 'message.posted'), data: message };
    await nats.seed([savedClose, savedMessage]);
    const originalRead = nats.store.readStream.bind(nats.store);
    async function* heldRead(stream: string, fromSequence = 1, deadline = Infinity,
      includeConversationCloses = false) {
      if (stream === subject) {
        readStarted.resolve();
        await releaseRead.promise;
      }
      try {
        yield* originalRead(stream, fromSequence, deadline, includeConversationCloses);
      } catch (error) {
        readFailure = error;
        throw error;
      } finally {
        if (stream === subject) readFinished.resolve();
      }
    }
    vi.spyOn(nats.store, 'readStream').mockImplementation(heldRead);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fixture unavailable');
    const input = { url: `ws://127.0.0.1:${address.port}/bridge`,
      computerId: 'computer', assistantId: 'assistant', bearer: 'fixture' };
    const options = { silo: 'test', store: nats.store, keys: conversationKeys('/tmp') };
    const wake = { signal: control.signal, deadline: performance.now() + 300 };
    const pending = connectBridge(options, input, undefined, wake);
    await readStarted.promise;
    control.abort();
    await expect(pending).rejects.toThrow();
    releaseRead.resolve();
    await readFinished.promise;
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(readFailure).toBeUndefined();
    const decisions = await nats.store.readStream('decision-*');
    const saved = [];
    for await (const row of decisions) saved.push(row);
    expect(saved).toEqual([]);
  } finally {
    control.abort();
    releaseRead.resolve();
    vi.restoreAllMocks();
    for (const client of sockets.clients) client.terminate();
    await new Promise<void>(resolve => sockets.close(resolve));
    server.close();
    await nats.close();
  }
}

it('does not save a recovered budget refusal after bridge wake cancellation',
  cancelledReportRecoveryDoesNotSaveBudgetRefusal);
