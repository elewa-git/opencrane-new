import { createServer, type Server, type Socket } from 'node:net';
import { runnerProtected } from './runner-protection.ts';

export type ServiceRole = 'serverDelivery' | 'bridge' | 'supervisor' | 'proxy' |
  'canaryHelper';

function answer(socket: Socket, bytes: Buffer, ready: () => boolean): void {
  const request = bytes.toString('utf8');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\n$/u.test(request)) {
    socket.destroy();
    return;
  }
  const challenge = request.slice(0, -1);
  if (!ready()) {
    socket.destroy();
    return;
  }
  const result = runnerProtected();
  socket.end(`${challenge}|${String(result)}\n`);
}

function serve(socket: Socket, ready: () => boolean): void {
  let request = Buffer.alloc(0);
  function receive(chunk: Buffer): void {
    if (request.length + chunk.length > 64) {
      socket.destroy();
      return;
    }
    request = Buffer.concat([request, chunk]);
    if (request.includes(10)) {
      socket.removeListener('data', receive);
      answer(socket, request, ready);
    }
  }
  function timedOut(): void {
    socket.destroy();
  }
  function disconnected(): void {
    socket.destroy();
  }
  socket.setTimeout(2_000);
  socket.on('data', receive);
  socket.on('error', disconnected);
  socket.once('timeout', timedOut);
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>(function waitForClose(resolve, reject): void {
    server.close(function closed(error): void {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function nothingToClose(): Promise<void> {}

export async function startServiceProtection(role: ServiceRole,
  ready: () => boolean = alwaysReady): Promise<() => Promise<void>> {
  const result = runnerProtected();
  if (result !== true) {
    // Development installations without the native helper cannot provide proof.
    return nothingToClose;
  }
  function guardedServe(socket: Socket): void {
    serve(socket, ready);
  }
  const server = createServer(guardedServe);
  const address = `\0opencrane-private-${role}`;
  await new Promise<void>(function listen(resolve, reject) {
    server.once('error', reject);
    server.listen(address, function ready() {
      server.off('error', reject);
      resolve();
    });
  });
  function closeProtection(): Promise<void> {
    return closeServer(server);
  }
  return closeProtection;
}

function alwaysReady(): boolean {
  return true;
}
