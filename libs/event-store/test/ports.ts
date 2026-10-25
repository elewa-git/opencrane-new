import { once } from 'node:events';
import { createServer, type Socket } from 'node:net';

const portsPerWorker = 200;
let nextOffset = 0;

function workerPortStart() {
  const worker = Number(process.env['VITEST_POOL_ID'] ?? 1);
  // Leave 25100 and 25200 for the secondary dev stacks, and 32768 upwards for clients.
  if (!Number.isInteger(worker) || worker < 0 || worker > 24) {
    throw new Error('Test port allocation supports Vitest workers 0 to 24');
  }
  return 20_000 + worker * portsPerWorker;
}

function closeProbe(socket: Socket) {
  socket.destroy();
}

async function reserve(port: number) {
  const listener = createServer(closeProbe);
  try {
    listener.listen(port, '127.0.0.1');
    await once(listener, 'listening');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EADDRINUSE') {
      return undefined;
    }
    throw error;
  }
  async function release() {
    if (!listener.listening) {
      return;
    }
    const closed = once(listener, 'close');
    listener.close();
    await closed;
  }
  return { port, release };
}

export async function reservePort() {
  const first = workerPortStart();
  for (let attempt = 0; attempt < portsPerWorker; attempt++) {
    const port = first + nextOffset;
    nextOffset = (nextOffset + 1) % portsPerWorker;
    // Hold the listener so other test processes cannot choose this port during setup.
    const reservation = await reserve(port);
    if (reservation) {
      return reservation;
    }
  }
  throw new Error('All test ports for this Vitest worker are in use');
}

export async function freePort() {
  const reservation = await reservePort();
  await reservation.release();
  return reservation.port;
}
