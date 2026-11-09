import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { chatFixture } from './chat-fixture.mjs';

const output = resolve('docs/process/evidence/chat-tail-window');
function fixtureRows() {
  const savedRows = [];
  for (let index = 1; index <= 35; index += 1) {
    const turnId = `saved-${index}`;
    savedRows.push({ id: turnId, position: savedRows.length + 1, type: 'message.posted',
      time: '2026-11-09T09:00:00Z', data: { authorId: 'me', text: `Saved message ${index}` } });
    savedRows.push({ id: `done-${index}`, position: savedRows.length + 1,
      type: 'agent.turn_completed', time: '2026-11-09T09:01:00Z', data: { turnId } });
  }
  return savedRows;
}
const rows = fixtureRows();

function replyFor(request) {
  const url = new URL(request.url());
  const tail = Number(url.searchParams.get('tail'));
  const before = Number(url.searchParams.get('before'));
  const limit = Number(url.searchParams.get('limit'));
  let visibleRows = rows;
  if (tail) visibleRows = rows.slice(-tail);
  if (before) visibleRows = rows.filter(row => row.position < before).slice(-limit);
  const oldest = visibleRows[0]?.position ?? 0;
  const cursor = oldest > 1 ? oldest : null;
  return { rows: visibleRows, position: rows.length, generation: 1,
    computerState: 'ready', dispatcherReady: true, before: cursor };
}

async function startWeb() {
  const command = resolve('node_modules/@angular/cli/bin/ng.js');
  const ports = resolve('apps/server/test/support/ephemeral-ports.ts');
  const web = spawn(process.execPath,
    ['--experimental-strip-types', '--import', ports, command, 'serve',
      '--prebundle=false', '--live-reload=false', '--hmr=false',
      '--host', '127.0.0.1', '--port', '0'],
    { cwd: resolve('apps/web'), stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' } });
  let logs = '';
  web.stdout.on('data', chunk => { logs += chunk.toString(); });
  web.stderr.on('data', chunk => { logs += chunk.toString(); });
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const origin = /Local:\s+(http:\/\/127\.0\.0\.1:\d+)/.exec(logs)?.[1];
    if (origin) return { web, origin };
    if (web.exitCode !== null) break;
    await delay(100);
  }
  web.kill();
  throw new Error(`Web fixture did not start: ${logs}`);
}

async function capture(browser, origin, width) {
  const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 900 },
    reducedMotion: 'reduce' });
  try {
    await chatFixture(page, 'live');
    await page.route('**/api/conversations/chat/messages?*', route => {
      const body = JSON.stringify(replyFor(route.request()));
      return route.fulfill({ contentType: 'application/json', body });
    });
    await page.goto(`${origin}/workspace?conversation=chat`);
    await page.getByText('Saved message 35', { exact: true }).waitFor();
    const visibleText = await page.locator('.transcript').innerText();
    assert(!visibleText.includes('Saved message 10'));
    await page.screenshot({ path: `${output}/${width}-tail.png` });
    await page.locator('.transcript').evaluate(element => { element.scrollTop = 0; });
    await page.getByText('Saved message 1', { exact: true }).waitFor();
    await page.screenshot({ path: `${output}/${width}-older.png` });
  } finally {
    await page.close();
  }
}

await mkdir(output, { recursive: true });
const { web, origin } = await startWeb();
try {
  const browser = await chromium.launch();
  try {
    for (const width of [1280, 390]) await capture(browser, origin, width);
  } finally {
    await browser.close();
  }
} finally {
  web.kill();
}
console.log('PASS: tail and older-page captures at 1280 px and 390 px');
