import { createServer, connect } from 'node:net';

const registryHost = process.argv[2];
const registryPort = Number(process.argv[3]);
const listenPort = Number(process.argv[4]);

if (!registryHost || !registryPort || !listenPort) {
  throw new Error('Pass the registry address, registry port and local port');
}

function forward(client) {
  const registry = connect(registryPort, registryHost);
  client.pipe(registry);
  registry.pipe(client);
  client.on('error', closeRegistry);
  registry.on('error', closeClient);

  function closeRegistry() {
    registry.destroy();
  }

  function closeClient() {
    client.destroy();
  }
}

function reportListening() {
  process.stdout.write(`Forwarding 127.0.0.1:${listenPort} to ${registryHost}:${registryPort}\n`);
}

const server = createServer(forward);
server.listen(listenPort, '127.0.0.1', reportListening);

function stop() {
  server.close();
}

process.on('SIGINT', stop);
process.on('SIGTERM', stop);
