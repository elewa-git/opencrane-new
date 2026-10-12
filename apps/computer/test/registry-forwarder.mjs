import { createServer, connect } from 'node:net';

const registryHost = process.argv[2];
const registryPort = Number(process.argv[3]);
const listenPort = Number(process.argv[4]);

if (!registryHost || !registryPort || !listenPort) {
  throw new Error('Pass the registry address, registry port and local port');
}

const sockets = new Set();

function track(socket) {
  sockets.add(socket);
  function closed() { sockets.delete(socket); }
  socket.on('close', closed);
}

function forward(client) {
  const registry = connect(registryPort, registryHost);
  track(client);
  track(registry);
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

let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  const deadline = setTimeout(shutdownFailed, 1000);
  function closed() { clearTimeout(deadline); }
  server.close(closed);
  for (const socket of sockets) socket.destroy();
}

function shutdownFailed() {
  process.exit(1);
}

process.on('SIGINT', stop);
process.on('SIGTERM', stop);
