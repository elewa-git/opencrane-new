import { createServer, type Socket } from 'node:net';
import { runnerProtected } from './runner-protection.ts';

export type ServiceRole = 'serverDelivery' | 'bridge' | 'supervisor';

function answer(socket: Socket, bytes: Buffer): void {
  const request = bytes.toString('utf8');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\n$/u.test(request)) {
    socket.destroy();
    return;
  }
  const challenge = request.slice(0, -1);
  const result = runnerProtected();
  socket.end(`${challenge}|${String(result)}\n`);
}

function serve(socket: Socket): void {
  let request = Buffer.alloc(0);
  function receive(chunk: Buffer): void {
    if (request.length + chunk.length > 64) {
      socket.destroy();
      return;
    }
    request = Buffer.concat([request, chunk]);
    if (request.includes(10)) {
      socket.removeListener('data', receive);
      answer(socket, request);
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

export async function startServiceProtection(role: ServiceRole): Promise<void> {
  const result = runnerProtected();
  if (result !== true) {
    // Development installations without the native helper cannot provide proof.
    return;
  }
  const server = createServer(serve);
  const address = `\0opencrane-private-${role}`;
  await new Promise<void>(function listen(resolve, reject) {
    server.once('error', reject);
    server.listen(address, function ready() {
      server.off('error', reject);
      resolve();
    });
  });
}
