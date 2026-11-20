import http from 'node:http';
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';

const connect = net.connect;
const listen = http.Server.prototype.listen;
const createServer = http.createServer;
let viewerSocket;

function redirectedConnection(...args) {
  const options = args[0];
  if (options === 8080 && args[1] === 'server') {
    return connect(Number(process.env.WEB_PROXY_TEST_PORT), '127.0.0.1');
  }
  if (options && typeof options === 'object' && options.host === 'server') {
    const target = { ...options, host: '127.0.0.1',
      port: Number(process.env.WEB_PROXY_TEST_PORT) };
    return connect(target, ...args.slice(1));
  }
  return connect(...args);
}

function rememberViewer(_request, socket) {
  viewerSocket = socket;
}

function instrumentedServer(...args) {
  const server = createServer(...args);
  server.on('upgrade', rememberViewer);
  return server;
}

function ready() {
  process.send({ kind: 'ready', port: this.address().port });
}

function isolatedListener(...args) {
  if (args[0] === 8080) {
    args[0] = 0;
    args[1] = '127.0.0.1';
    this.once('listening', ready);
  }
  return listen.apply(this, args);
}

function control(message) {
  if (message.kind === 'viewer_write_failure') {
    // Inject the kernel's write failure at the real client transport boundary.
    const error = new Error('Fixture viewer transport closed');
    error.code = 'EPIPE';
    viewerSocket.destroy(error);
  } else if (message.kind === 'ping') {
    process.send({ kind: 'alive' });
  }
}

http.createServer = instrumentedServer;
http.Server.prototype.listen = isolatedListener;
http.Agent.prototype.createConnection = redirectedConnection;
net.connect = redirectedConnection;
net.createConnection = redirectedConnection;
syncBuiltinESMExports();
process.on('message', control);
