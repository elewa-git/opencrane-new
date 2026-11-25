import { requireFleetStandInProvider } from './journey-guard.ts';
import { requirePackageProviderDestination } from '../package/model-settings.ts';
import { startConnectionCustodyBridge } from './connection-custody-bridge.ts';
// The pinned gateway binds wildcard sockets. Keep them inside Compose; only
// loopback Docker publications and the private k3d relay can reach this stack.
import { networkInterfaces } from 'node:os';
import { createConnection, createServer, type Socket, type Server } from 'node:net';

const sockets = new Set<Socket>();
const servers: Server[] = [];
const realProvider = process.env['DEV_REAL_PROVIDER'] === '1';
const packagedProvider = process.env['PACKAGE_PROVIDER_MODE'] === '1';
const qualification = process.env['PACKAGE_PROVIDER_QUALIFICATION'] === '1';
requirePackageProviderDestination(process.env);
requireFleetStandInProvider(realProvider || (packagedProvider && !qualification));
const localStandIn = !realProvider && !packagedProvider;
const forwardedPorts = ['MODEL_DECISION_PORT', 'MODEL_READINESS_PORT'];
if (localStandIn) {
  forwardedPorts.push('MODEL_STUB_PORT');
}
for (const name of forwardedPorts) {
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
const custodySocket = process.env['CONNECTION_CUSTODY_SOCKET'];
if (custodySocket) {
  await startConnectionCustodyBridge(custodySocket, Number(process.env['CUSTODY_PROXY_PORT']));
}
if (localStandIn) await import('./model-stub.ts');
await import('../../apps/server/src/models-main.ts');
