import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { test } from 'node:test';
import { closeFixtureServers } from './tls-cleanup.mjs';

async function closesConnectTunnel() {
  const server = createServer();
  let accepted;
  function connected(request, socket) {
    accepted = socket;
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
  }
  server.on('connect', connected);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const client = connect(address.port, '127.0.0.1');
  await once(client, 'connect');
  const received = once(client, 'data');
  client.write('CONNECT example.test:443 HTTP/1.1\r\nHost: example.test:443\r\n\r\n');
  await received;
  try {
    const servers = [server];
    const sockets = new Set([accepted]);
    closeFixtureServers(servers, sockets);
    assert.equal(accepted.destroyed, true, 'Qualification cleanup leaves its CONNECT tunnel open');
  } finally {
    client.destroy();
    accepted?.destroy();
    if (server.listening) server.close();
  }
}

test('qualification cleanup closes upgraded CONNECT tunnels', closesConnectTunnel);
