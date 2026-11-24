import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { WebSocketServer } from 'ws';
import { startWebServer } from '../infra/dev-stack/web-server.mjs';
import { rfbHandshake } from './rfb-fixture.mjs';

const execute = promisify(execFile);

function framebuffer(pixelFormat) {
  // Use a known colour so a blank canvas cannot pass.
  const bytes = Buffer.alloc(20);
  bytes.writeUInt16BE(1, 2);
  bytes.writeUInt16BE(1, 8);
  bytes.writeUInt16BE(1, 10);
  const red = pixelFormat.readUInt16BE(8);
  const redPixel = red * 2 ** pixelFormat[14];
  if (pixelFormat[6] === 1) {
    bytes.writeUInt32BE(redPixel, 16);
  } else {
    bytes.writeUInt32LE(redPixel, 16);
  }
  return bytes;
}

function connectDesktop(socket) {
  const { version, replies } = rfbHandshake(800, 600);
  let step = 0;
  let frameSent = false;
  let pixelFormat;
  function renewLease() {
    const at = Date.now();
    const notice = { lease: 'valid', at, until: at + 1500 };
    const message = JSON.stringify(notice);
    socket.send(message);
  }
  function receive(bytes) {
    const reply = replies[step];
    if (reply) {
      socket.send(reply);
    } else if (step === replies.length) {
      assert.equal(bytes[0], 0, 'The viewer selects its pixel format');
      assert.equal(bytes[4], 32, 'The fixture uses 32-bit pixels');
      pixelFormat = Buffer.from(bytes);
    } else if (bytes[0] === 3 && !frameSent) {
      const frame = framebuffer(pixelFormat);
      socket.send(frame);
      frameSent = true;
    }
    step++;
  }
  renewLease();
  const timer = setInterval(renewLease, 250);
  function disconnected() {
    clearInterval(timer);
  }
  socket.once('close', disconnected);
  socket.on('message', receive);
  socket.send(version);
}

function admitViewer(_request, response) {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end('{"ticket":"fixture-ticket"}');
}

function viewerState() {
  // The closed dialog keeps its initial Disconnected message in the document.
  const state = globalThis.document.querySelector('dialog[open] [role="status"] .message');
  const text = state?.textContent?.trim();
  if (text === 'Viewing' || text === 'Disconnected' || text === 'Failed') {
    return text;
  }
  return false;
}

function decodedPixel() {
  const canvas = globalThis.document.querySelector('dialog canvas');
  if (!canvas || canvas.width !== 800 || canvas.height !== 600) {
    return false;
  }
  const context = canvas.getContext('2d');
  const image = context.getImageData(0, 0, 1, 1);
  const pixel = image.data;
  return pixel[0] === 255 && pixel[1] === 0 && pixel[2] === 0 && pixel[3] === 255;
}

async function checkViewer(browser, origin, width) {
  const viewport = { width, height: 900 };
  const page = await browser.newPage({ viewport });
  try {
    await page.goto(origin);
    const entry = page.getByRole('button', { name: 'Watch your computer', exact: true });
    await entry.waitFor();
    const closedState = await page.evaluate(viewerState);
    assert.equal(closedState, false,
      'The closed desktop dialog must not report a viewing result');
    await entry.click();
    const state = await page.waitForFunction(viewerState);
    const connectedState = await state.jsonValue();
    assert.equal(connectedState, 'Viewing',
      `The ${width}px production viewer must construct noVNC and finish its RFB handshake`);
    await page.waitForFunction(decodedPixel);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('dialog canvas').count(), 0);
  } finally {
    await page.close();
  }
}

async function main() {
  const buildOptions = { timeout: 300_000, env: { ...process.env, NO_COLOR: '1' } };
  const buildArguments = ['-n', '10', 'npm', 'run', 'build:live-view-test', '-w', 'apps/web'];
  await execute('nice', buildArguments, buildOptions);
  const directory = await mkdtemp(join(tmpdir(), 'live-view-production-'));
  const backend = createServer(admitViewer);
  function selectProtocol() {
    return 'binary';
  }
  const websocketOptions = { server: backend, handleProtocols: selectProtocol };
  const desktops = new WebSocketServer(websocketOptions);
  desktops.on('connection', connectDesktop);
  let website;
  let browser;
  try {
    backend.listen(0, '127.0.0.1');
    await once(backend, 'listening');
    const target = `http://127.0.0.1:${backend.address().port}`;
    const configuration = { '/api': { target }, '/ws': { target, ws: true } };
    const proxyFile = join(directory, 'proxy.json');
    await writeFile(proxyFile, JSON.stringify(configuration));
    website = await startWebServer('apps/web/dist/live-view/browser', 0, 'localhost', proxyFile);
    browser = await chromium.launch();
    const origin = `http://127.0.0.1:${website.address().port}`;
    for (const width of [1280, 390]) {
      await checkViewer(browser, origin, width);
    }
    console.log('PASS production live viewer decodes RFB pixels at 1280 and 390 px');
  } finally {
    await browser?.close();
    for (const socket of desktops.clients) {
      socket.terminate();
    }
    desktops.close();
    website?.closeAllConnections();
    website?.close();
    backend.closeAllConnections();
    backend.close();
    await rm(directory, { recursive: true, force: true });
  }
}

await main();
