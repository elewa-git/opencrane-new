import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { chromium } from 'playwright';
import { startWebServer } from './web-server.mjs';

const buildDirectory = resolve('apps/web/dist/web/browser');
const execute = promisify(execFile);

async function buildWebsite() {
  const options = { timeout: 300_000, env: { ...process.env, NO_COLOR: '1' } };
  await execute('nice', ['-n', '10', 'npm', 'run', 'build', '-w', 'apps/web'], options);
}

async function listen(server) {
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  return server.address().port;
}

async function close(server) {
  await new Promise((resolveClose) => server.close(resolveClose));
}

async function responseAt(port, path, headers = {}) {
  return new Promise((resolveResponse, rejectResponse) => {
    const request = httpRequest({ hostname: '127.0.0.1', port, path, headers });
    function receive(response) {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolveResponse({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }));
      response.on('error', rejectResponse);
    }
    request.on('response', receive);
    request.on('error', rejectResponse);
    request.setTimeout(5_000, () => request.destroy(new Error(`Request timed out: ${path}`)));
    request.end();
  });
}

async function websocketStatus(port) {
  return new Promise((resolveStatus, rejectStatus) => {
    const headers = { connection: 'Upgrade', upgrade: 'websocket',
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13' };
    const request = httpRequest({ hostname: '127.0.0.1', port,
      path: '/ws/updates', headers });
    function upgraded(response, socket) {
      socket.once('close', () => resolveStatus(response.statusCode));
      socket.destroy();
    }
    request.on('upgrade', upgraded);
    request.on('error', rejectStatus);
    request.setTimeout(5_000, () => request.destroy(new Error('WebSocket upgrade timed out')));
    request.end();
  });
}

async function withWebServer(check) {
  const directory = await mkdtemp(`${tmpdir()}/web-build-test-`);
  const backendSockets = new Set();
  const backend = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end(request.url);
  });
  function recordBackendSocket(socket) {
    backendSockets.add(socket);
    function removeSocket() {
      backendSockets.delete(socket);
    }
    socket.on('close', removeSocket);
  }
  backend.on('connection', recordBackendSocket);
  function acceptWebsocket(request, socket) {
    if (request.url !== '/ws/updates') {
      socket.destroy();
      return;
    }
    socket.write('HTTP/1.1 101 Switching Protocols\r\n'
      + 'Upgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
  }
  backend.on('upgrade', acceptWebsocket);
  const backendPort = await listen(backend);
  const configuration = {};
  for (const path of ['/api', '/auth', '/ws', '/members']) {
    configuration[path] = { target: `http://127.0.0.1:${backendPort}`, ws: path === '/ws' };
  }
  const proxyFile = `${directory}/proxy.json`;
  await writeFile(proxyFile, JSON.stringify(configuration));
  const web = await startWebServer(buildDirectory, 0, 'owner.example.test', proxyFile);
  const webSockets = new Set();
  function recordSocket(socket) {
    webSockets.add(socket);
    function removeSocket() {
      webSockets.delete(socket);
    }
    socket.on('close', removeSocket);
  }
  web.on('connection', recordSocket);
  try {
    await check(web.address().port);
  } finally {
    web.closeAllConnections();
    for (const socket of webSockets) socket.destroy();
    await close(web);
    backend.closeAllConnections();
    for (const socket of backendSockets) socket.destroy();
    await close(backend);
    await rm(directory, { recursive: true, force: true });
  }
}

async function checksProductionFiles() {
  await buildWebsite();
  async function inspect(port) {
    const library = await readFile(`${buildDirectory}/mermaid-library.js`);
    assert.ok(library.length < 8_000_000, 'The Mermaid bundle must be minified');
    assert.ok(library.subarray(0, 100).toString().includes('"use strict";var'));
    const compressed = await responseAt(port, '/mermaid-library.js', {
      'accept-encoding': 'gzip',
    });
    assert.equal(compressed.status, 200);
    assert.equal(compressed.headers['content-encoding'], 'gzip');
    assert.equal(compressed.headers['content-type'], 'text/javascript; charset=utf-8');
    assert.deepEqual(gunzipSync(compressed.body), library);
    assert.ok(compressed.body.length < 2_000_000, 'The transferred bundle must be small');

    const index = await responseAt(port, '/org/integrations');
    assert.equal(index.status, 200);
    assert.equal(index.headers['cache-control'], 'no-cache');
    assert.match(index.headers['content-security-policy'], /nonce-/u);
    assert.match(index.body.toString(), /ngCspNonce=/u);
    const renderer = await responseAt(port, '/mermaid-renderer.html');
    assert.equal(renderer.status, 200);
    assert.equal(renderer.headers['cache-control'], 'no-cache');
    assert.match(renderer.headers['content-security-policy'], /script-src 'self'/u);
    assert.match(renderer.body.toString(), /mermaid-library\.js/u);
    const rendererScript = await responseAt(port, '/mermaid-renderer.js');
    assert.equal(rendererScript.status, 200);
    assert.equal(rendererScript.headers['cache-control'], 'no-cache');
    const hashed = /(?:src|href)="([^"]+-[A-Z0-9]{8}\.(?:js|css))"/u.exec(index.body);
    assert.ok(hashed, 'The production index must name a hashed asset');
    const asset = await responseAt(port, `/${hashed[1]}`);
    assert.match(asset.headers['cache-control'], /immutable/u);
    for (const path of ['/api/probe', '/auth/probe', '/ws/probe', '/members/probe']) {
      const proxied = await responseAt(port, path);
      assert.equal(proxied.body.toString(), path);
    }
    const absolute = await responseAt(port, 'http://outside.example.test/api/probe');
    assert.equal(absolute.body.toString(), '/api/probe');
    assert.equal(await websocketStatus(port), 101);
    const refused = await responseAt(port, '/', { host: 'outside.example.test' });
    assert.equal(refused.status, 403);
    const local = await responseAt(port, '/', { host: 'localhost' });
    assert.equal(local.status, 200);
  }
  await withWebServer(inspect);
}

test('production Mermaid is minified and compressed, with the built website and proxy',
  checksProductionFiles, { timeout: 360_000 });

async function checksDiagramTime() {
  async function inspect(port) {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      const browserErrors = [];
      const requests = [];
      function recordPageError(error) {
        browserErrors.push(error.message);
      }
      function recordConsole(message) {
        if (message.type() === 'error') browserErrors.push(message.text());
      }
      page.on('pageerror', recordPageError);
      page.on('console', recordConsole);
      function recordResponse(response) {
        requests.push(`${response.status()} ${new URL(response.url()).pathname}`);
      }
      page.on('response', recordResponse);
      await page.goto(`http://127.0.0.1:${port}/index.html`);
      let result;
      try {
        result = await page.evaluate(async () => {
        const startedAt = performance.now();
        const frame = document.createElement('iframe');
        frame.sandbox.add('allow-scripts');
        frame.src = '/mermaid-renderer.html';
        document.body.append(frame);
        return new Promise((resolveDiagram, rejectDiagram) => {
          const timer = setTimeout(() => rejectDiagram(new Error('Diagram timed out')), 15_000);
          function receive(event) {
            if (event.source !== frame.contentWindow) return;
            if (event.data === 'mermaid-ready') {
              frame.contentWindow.postMessage({ id: 1, code: 'graph LR\nStart --> Done' }, '*');
              return;
            }
            if (event.data?.id !== 1) return;
            clearTimeout(timer);
            window.removeEventListener('message', receive);
            resolveDiagram({ elapsedMs: performance.now() - startedAt, svg: event.data.svg });
          }
          window.addEventListener('message', receive);
        });
        });
      } catch (error) {
        throw new Error(`${error.message}: ${browserErrors.join('; ')}; ${requests.join('; ')}`);
      }
      assert.match(result.svg, /<svg/u);
      assert.ok(result.elapsedMs < 15_000, `Diagram took ${result.elapsedMs} ms`);
    } finally {
      await browser.close();
    }
  }
  await withWebServer(inspect);
}

test('a diagram renders through the production server within 15 seconds',
  checksDiagramTime, { timeout: 45_000 });

async function servesOrganisationName() {
  const previousName = process.env['ORGANISATION_NAME'];
  process.env['ORGANISATION_NAME'] = 'Acme <"&"> Sons';
  async function inspect(port) {
    for (const path of ['/index.html', '/signin/rejected', '/workspace']) {
      const response = await responseAt(port, path);
      assert.equal(response.status, 200);
      assert.match(response.body.toString(),
        /<meta name="opencrane-org" content="Acme &lt;&quot;&amp;&quot;&gt; Sons"/u);
      assert.match(response.headers['content-security-policy'], /nonce-/u);
    }
    const asset = await responseAt(port, '/mermaid-renderer.html');
    assert.doesNotMatch(asset.body.toString(), /Acme/u);
  }
  try {
    await withWebServer(inspect);
  } finally {
    if (previousName === undefined) delete process.env['ORGANISATION_NAME'];
    else process.env['ORGANISATION_NAME'] = previousName;
  }
}

test('the dev web server supplies the escaped installation name on direct and app routes',
  servesOrganisationName);
