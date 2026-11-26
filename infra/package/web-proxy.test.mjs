import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { createServer, request } from 'node:http';
import { connect, createServer as createTcpServer } from 'node:net';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { request as playwrightRequest } from 'playwright';
import { readBudgetSummary } from '../dev-stack/browser-budgets.ts';

function startWebProxy(backendPort) {
  const options = {
    env: { ...process.env, WEB_PROXY_TEST_PORT: String(backendPort) },
    execArgv: ['--import', resolve('infra/package/web-proxy-fixture.mjs')],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  };
  return fork(resolve('infra/package/web.mjs'), [], options);
}

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
    const options = { host: '127.0.0.1', port, path: '/ws/view', headers };
    const client = request(options);
    function upgraded(response, socket, head) {
      assert.equal(response.statusCode, 101);
      const viewer = { socket, head };
      resolveViewer(viewer);
    }
    client.once('upgrade', upgraded);
    client.once('error', rejectViewer);
    client.end();
  }
}

function healthy(port) {
  return new Promise(checkHealth);

  function checkHealth(resolveHealth, rejectHealth) {
    const options = { host: '127.0.0.1', port, path: '/api/health' };
    const client = request(options);
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
    response.writeHead(204);
    response.end();
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
  const child = startWebProxy(backend.address().port);
  let diagnostics = '';
  function errorOutput(bytes) {
    diagnostics += bytes.toString();
  }
  child.stderr.on('data', errorOutput);
  let viewer;
  function stopResources() {
    viewer?.socket.destroy();
    child.kill();
    for (const socket of sockets) {
      socket.destroy();
    }
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
    const failureMessage = { kind: 'viewer_write_failure' };
    child.send(failureMessage);
    await viewerClosed;
    const pingMessage = { kind: 'ping' };
    child.send(pingMessage);
    const reply = await alive;
    assert.equal(reply.kind, 'alive', diagnostics);
    await backendClosed;
    const status = await healthy(ready.port);
    assert.equal(status, 204, 'Other requests remain available');
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

const testOptions = { timeout: 10_000 };
test('a failed viewer write closes both connections and keeps packaged HTTP available',
  testOptions, viewerWriteFailure);

function forwardWithDelayedClose(webPort) {
  const websiteClosed = Promise.withResolvers();
  const sockets = new Set();
  let staleRequests = 0;
  function forward(client) {
    const website = connect(webPort, '127.0.0.1');
    sockets.add(client);
    client.pipe(website);
    // A remote close can race a request on the local port-forward connection.
    website.pipe(client, { end: false });
    function closeWebsite() {
      sockets.delete(client);
      website.destroy();
    }
    function closeStaleClient() {
      client.destroy();
    }
    function rejectStaleRequest() {
      staleRequests++;
      closeStaleClient();
    }
    function websiteEnded() {
      client.once('data', rejectStaleRequest);
      client.resume();
      websiteClosed.resolve();
    }
    client.once('close', closeWebsite);
    client.once('error', closeStaleClient);
    website.once('error', closeStaleClient);
    website.once('close', websiteEnded);
  }
  const server = createTcpServer(forward);
  function stop() {
    for (const client of sockets) client.destroy();
    server.close();
  }
  function countStaleRequests() {
    return staleRequests;
  }
  return { server, websiteClosed: websiteClosed.promise, countStaleRequests, stop };
}

async function rereadAfterWebsiteIdle(context) {
  const cookies = [];
  function budget(incoming, response) {
    cookies.push(incoming.headers.cookie);
    response.setHeader('content-type', 'application/json');
    const budget = { sequence: cookies.length, ceilingCents: 500, todayCents: 0,
      monthCents: 0, reservedCents: 0, periodStart: null, defaultPayingGroupId: 'example',
      dailyCeilingCents: 0, ceilings: [] };
    response.end(JSON.stringify({ budget }));
  }
  const backend = createServer({ keepAliveTimeout: 72_000 }, budget);
  function closeBackend() {
    backend.close();
    backend.closeAllConnections();
  }
  context.after(closeBackend);
  backend.listen(0, '127.0.0.1');
  await once(backend, 'listening');
  const child = startWebProxy(backend.address().port);
  function closeWeb() {
    child.kill();
  }
  context.after(closeWeb);
  const ready = await childMessage(child);
  assert.equal(ready.kind, 'ready');
  const forward = forwardWithDelayedClose(ready.port);
  context.after(forward.stop);
  forward.server.listen(0, '127.0.0.1');
  await once(forward.server, 'listening');
  const session = { name: 'fixture', value: 'session', domain: '127.0.0.1', path: '/',
    expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' };
  const client = await playwrightRequest.newContext({ storageState: {
    cookies: [session], origins: [],
  } });
  function closeClient() {
    return client.dispose();
  }
  context.after(closeClient);
  const origin = `http://127.0.0.1:${forward.server.address().port}`;
  const owner = { request: client };

  const initial = await readBudgetSummary(owner, origin);
  assert.equal(initial.sequence, 1);
  assert.equal(initial.ceilingCents, 500);
  await forward.websiteClosed;

  const readback = await readBudgetSummary(owner, origin);
  assert.equal(readback.sequence, 2);
  assert.equal(readback.ceilingCents, 500);
  assert.deepEqual(cookies, ['fixture=session', 'fixture=session'],
    'Each budget GET arrives once with the same browser session');
  assert.equal(forward.countStaleRequests(), 0);

  const normalReply = await client.get(`${origin}/api/org/models`);
  assert.equal(normalReply.status(), 200);
  assert.match(normalReply.headers()['keep-alive'], /^timeout=5\b/u,
    'A client that keeps connections open sees the website timeout');
}

test('a budget read uses a fresh connection after the website connection expires',
  testOptions, rereadAfterWebsiteIdle);
