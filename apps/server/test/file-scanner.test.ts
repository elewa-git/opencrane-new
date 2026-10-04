import { once } from 'node:events';
import { createServer, type Socket } from 'node:net';
import { expect, it, vi } from 'vitest';
import { FileUnavailable } from '../src/files/refusals.ts';
import { scanFile } from '../src/files/scanner.ts';

async function scannerTimeout() {
  const sockets = new Set<Socket>();
  function withholdVerdict(socket: Socket) {
    sockets.add(socket);
    socket.resume();
  }
  const server = createServer(withholdVerdict);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Scanner fixture has no port');
  }
  const fakeTimerOptions: Parameters<typeof vi.useFakeTimers>[0] = {
    toFake: ['setTimeout', 'clearTimeout'],
  };
  vi.useFakeTimers(fakeTimerOptions);
  try {
    const connected = once(server, 'connection');
    const scan = scanFile('127.0.0.1', address.port, Buffer.from('Meeting at ten.'));
    const typedRefusal = expect(scan).rejects.toBeInstanceOf(FileUnavailable);
    await connected;
    await vi.advanceTimersByTimeAsync(60_000);
    await typedRefusal;
    await expect(scan).rejects.toMatchObject({ kind: 'scanner', statusCode: 503 });
  } finally {
    vi.useRealTimers();
    for (const socket of sockets) {
      socket.destroy();
    }
    server.close();
    await once(server, 'close');
  }
}

it('marks the scanner deadline as a typed 503 outage', scannerTimeout);
