// The pinned gateway binds wildcard sockets. Keep them inside Compose; only
// loopback Docker publications and the private k3d relay can reach this stack.
import { networkInterfaces } from 'node:os';
import { createConnection, createServer, type Socket, type Server } from 'node:net';

const sockets = new Set<Socket>();
const servers: Server[] = [];
for (const name of ['MODEL_DECISION_PORT', 'MODEL_READINESS_PORT', 'MODEL_STUB_PORT', 'MCP_FIXTURE_PORT']) {
  const port = Number(process.env[name]);
  // These existing listeners bind loopback. Forward the container interfaces
  // without widening their production listeners or changing the owner stack.
  for (const address of Object.values(networkInterfaces()).flat()) {
    if (!address || address.internal || address.family !== 'IPv4') continue;
    const server = createServer(incoming => {
      const outgoing = createConnection({ host: '127.0.0.1', port });
      for (const socket of [incoming, outgoing]) {
        sockets.add(socket);
        socket.on('error', () => { incoming.destroy(); outgoing.destroy(); });
        socket.on('close', () => sockets.delete(socket));
      }
      incoming.pipe(outgoing).pipe(incoming);
    }).listen(port, address.address);
    servers.push(server);
  }
}
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
  for (const server of servers) server.close();
  for (const socket of sockets) socket.destroy();
});
await import('./model-stub.ts');
await import('./journey-models.ts');
