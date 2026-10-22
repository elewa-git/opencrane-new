import { once } from 'node:events';
import { createServer } from 'node:net';

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

async function portIsAvailable(port: number) {
  const listener = createServer();
  try {
    listener.listen(port, '127.0.0.1');
    await once(listener, 'listening');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EADDRINUSE') {
      return false;
    }
    throw error;
  }
  const closed = once(listener, 'close');
  listener.close();
  await closed;
  return true;
}

export async function freePort() {
  const first = workerPortStart();
  for (let attempt = 0; attempt < portsPerWorker; attempt++) {
    const port = first + nextOffset;
    nextOffset = (nextOffset + 1) % portsPerWorker;
    // Skip listeners from other test runs. Keep simultaneous callers on different ports.
    if (await portIsAvailable(port)) {
      return port;
    }
  }
  throw new Error('All test ports for this Vitest worker are in use');
}
