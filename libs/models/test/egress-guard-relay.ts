import { once } from 'node:events';
import { connect, createServer, type Socket } from 'node:net';
import { onTestFinished } from 'vitest';
import { connectEgressDestination } from '../src/egress-guard.ts';

export async function guardRelay(upstreamPort: number) {
  const sockets = new Set<Socket>();
  function resolve() {
    return Promise.resolve([{ address: '1.1.1.1', family: 4 }]);
  }
  function connector(address: string, port: number) {
    if (address !== '1.1.1.1' || port !== 443) throw new Error('Unapproved destination');
    const socket = connect(upstreamPort, '127.0.0.1');
    sockets.add(socket);
    return socket;
  }
  async function forward(socket: Socket) {
    const destination = { host: 'registry.npmjs.org', port: 443 };
    const transport = { resolve, connect: connector };
    const result = await connectEgressDestination(socket, destination, transport);
    result.upstream.write(result.initialData);
    socket.pipe(result.upstream);
    result.upstream.pipe(socket);
  }
  function accepted(socket: Socket) {
    sockets.add(socket);
    function refused() {
      socket.destroy();
    }
    void forward(socket).catch(refused);
  }
  const listener = createServer(accepted);
  async function close() {
    for (const socket of sockets) socket.destroy();
    const closed = once(listener, 'close');
    listener.close();
    await closed;
  }
  onTestFinished(close);
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const address = listener.address();
  if (!address || typeof address === 'string') throw new Error('No guard listener');
  return address.port;
}
