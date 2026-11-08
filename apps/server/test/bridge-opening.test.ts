import { createServer } from 'node:http';
import { once } from 'node:events';
import type { Socket } from 'node:net';
import { WebSocket } from 'ws';
import { expect, it, vi } from 'vitest';
import { until } from '@opencrane/authz/testing';
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
