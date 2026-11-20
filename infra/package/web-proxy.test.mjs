import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { createServer, request } from 'node:http';
import { resolve } from 'node:path';
import { test } from 'node:test';

function childMessage(child) {
  return new Promise(waitForMessage);

  function waitForMessage(resolveMessage, rejectMessage) {
    function received(message) {
      child.removeListener('exit', exited);
      resolveMessage(message);
    }
    function exited() {
      child.removeListener('message', received);
      rejectMessage(new Error('Packaged web process exited after a viewer write failure'));
    }
    child.once('message', received);
    child.once('exit', exited);
  }
}

function upgrade(port) {
  return new Promise(connectViewer);

  function connectViewer(resolveViewer, rejectViewer) {
    const headers = { connection: 'Upgrade', upgrade: 'websocket' };
    const client = request({ host: '127.0.0.1', port, path: '/ws/view', headers });
    function upgraded(response, socket, head) {
      assert.equal(response.statusCode, 101);
      resolveViewer({ socket, head });
    }
    client.once('upgrade', upgraded);
    client.once('error', rejectViewer);
    client.end();
  }
}

function healthy(port) {
  return new Promise(checkHealth);

  function checkHealth(resolveHealth, rejectHealth) {
    const client = request({ host: '127.0.0.1', port, path: '/api/health' });
    function received(response) {
      response.resume();
      response.once('end', finished);
      function finished() {
        resolveHealth(response.statusCode);
      }
    }
    client.once('response', received);
    client.once('error', rejectHealth);
    client.end();
  }
}

async function viewerWriteFailure(context) {
  const sockets = new Set();
  let upgradedSocket;
  function respond(_request, response) {
    response.writeHead(204).end();
  }
  const backend = createServer(respond);
  function track(socket) {
    sockets.add(socket);
    function removed() {
      sockets.delete(socket);
    }
    socket.once('close', removed);
  }
  function accept(_request, socket) {
    upgradedSocket = socket;
    function finish() {
      socket.end();
    }
    socket.once('end', finish);
    socket.resume();
    socket.write('HTTP/1.1 101 Switching Protocols\r\n'
      + 'Connection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
  }
  backend.on('connection', track);
  backend.on('upgrade', accept);
  backend.listen(0, '127.0.0.1');
  await once(backend, 'listening');
  const options = {
    env: { ...process.env, WEB_PROXY_TEST_PORT: String(backend.address().port) },
    execArgv: ['--import', resolve('infra/package/web-proxy-fixture.mjs')],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  };
  const child = fork(resolve('infra/package/web.mjs'), [], options);
  let diagnostics = '';
  function errorOutput(bytes) {
    diagnostics += bytes.toString();
  }
  child.stderr.on('data', errorOutput);
  let viewer;
  function stopResources() {
    viewer?.socket.destroy();
    child.kill();
    for (const socket of sockets) socket.destroy();
    backend.close();
  }
  context.after(stopResources);
  try {
    const ready = await childMessage(child);
    assert.equal(ready.kind, 'ready');
    viewer = await upgrade(ready.port);
    const viewerClosed = once(viewer.socket, 'close');
    const backendClosed = once(upgradedSocket, 'close');
    const alive = childMessage(child);
    child.send({ kind: 'viewer_write_failure' });
    await viewerClosed;
    child.send({ kind: 'ping' });
    assert.equal((await alive).kind, 'alive', diagnostics);
    await backendClosed;
    assert.equal(await healthy(ready.port), 204, 'Other requests remain available');
  } finally {
    const stopped = child.exitCode === null && child.signalCode === null
      ? once(child, 'exit') : undefined;
    const closed = backend.listening ? once(backend, 'close') : undefined;
    stopResources();
    if (stopped) await stopped;
    if (closed) await closed;
    assert.doesNotMatch(diagnostics, /Unhandled 'error' event/u,
      'A viewer EPIPE must not terminate the packaged web process');
  }
}

test('a failed viewer write closes both connections and keeps packaged HTTP available',
  { timeout: 10_000 }, viewerWriteFailure);
