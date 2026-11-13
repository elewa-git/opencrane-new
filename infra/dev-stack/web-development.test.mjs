import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { uploadPdf } from '../../apps/server/test/support/upload-pdf.ts';

async function unusedPort() {
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  function close(done) {
    reservation.close(done);
  }
  await new Promise(close);
  return port;
}

async function waitForWebsite(origin, child, output) {
  const deadline = performance.now() + 300_000;
  while (performance.now() < deadline) {
    assert.equal(child.exitCode, null, output());
    try {
      const response = await fetch(origin);
      if (response.ok) return response;
    } catch (error) {
      if (error.cause?.code !== 'ECONNREFUSED') throw error;
    }
    await delay(100);
  }
  assert.fail(`Development website did not start: ${output()}`);
}

function openPdf(bytes) {
  function previewResult(done) {
    function blocked(event) {
      done({ blocked: true, directive: event.violatedDirective,
        policy: event.originalPolicy, uri: event.blockedURI });
    }
    document.addEventListener('securitypolicyviolation', blocked, { once: true });
    const pdf = new Blob([new Uint8Array(bytes)], { type: 'application/pdf' });
    const frame = document.createElement('iframe');
    frame.src = URL.createObjectURL(pdf);
    function loaded() {
      done({ blocked: false });
    }
    frame.addEventListener('load', loaded, { once: true });
    document.body.append(frame);
  }
  return new Promise(previewResult);
}

async function checksDevelopmentPreview() {
  const directory = await mkdtemp(`${tmpdir()}/development-preview-`);
  const port = await unusedPort();
  const origin = `http://127.0.0.1:${port}`;
  await writeFile(`${directory}/index.html`,
    '<html><head><meta name="opencrane-org" content=""></head><body></body></html>');
  await writeFile(`${directory}/proxy.json`, '{}');
  const args = [resolve('infra/dev-stack/web-server.mjs'), directory,
    String(port), 'example.test', `${directory}/proxy.json`, '--development'];
  const child = spawn(process.execPath, args, {
    env: { ...process.env, ORGANISATION_NAME: 'Acme <"&"> Sons', NG_BUILD_MAX_WORKERS: '2' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  function record(chunk) {
    logs += chunk.toString();
  }
  function output() {
    return logs;
  }
  child.stdout.on('data', record);
  child.stderr.on('data', record);
  let browser;
  try {
    const response = await waitForWebsite(origin, child, output);
    browser = await chromium.launch({ channel: 'chromium' });
    const page = await browser.newPage();
    await page.goto(origin);
    const policy = response.headers.get('content-security-policy');
    const preview = await page.evaluate(openPdf, [...uploadPdf()]);
    assert.equal(preview.blocked, false, `PDF preview blocked: ${JSON.stringify(preview)}; ${policy}`);
    const name = await page.locator('meta[name="opencrane-org"]').getAttribute('content');
    assert.equal(name, 'Acme <"&"> Sons');
    assert.match(await response.text(), /@vite\/client/u,
      'The secondary website must retain Angular development serving');
  } finally {
    await browser?.close();
    child.kill('SIGTERM');
    if (child.exitCode === null) await once(child, 'exit');
    await rm(directory, { recursive: true, force: true });
  }
}

test('the secondary development page serves the installation name and permits the native PDF preview',
  { timeout: 360_000 }, checksDevelopmentPreview);
