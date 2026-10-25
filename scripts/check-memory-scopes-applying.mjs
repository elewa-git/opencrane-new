import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { chatFixture } from './chat-fixture.mjs';
import { serveWebBuild } from './serve-web-build.mjs';
import { pageHasNoOverflow, waitForFonts } from './visual-helpers.mjs';

const origin = 'https://memory-setup.opencrane.test';
const build = resolve('apps/web/dist/web/browser');
const output = '/tmp/memory-scopes-applying-captures';
const personalScope = {
  scopeId: 'personal', scopeKind: 'person', ownerId: 'me',
  audience: { kind: 'person', ownerId: 'me' }, canRead: true, canWrite: true,
};

async function serveBuild(route) {
  await serveWebBuild(route, build);
}

async function checkSetup(browser, width) {
  const viewport = { width, height: 900 };
  const page = await browser.newPage({ viewport });
  let permissionsReady = false;
  const reads = [];
  async function serveMemory(route) {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    reads.push({ path, method: request.method() });
    let status = 200;
    let body = { scopeId: 'personal', facts: [], returnedCount: 0, nextCursor: null };
    if (path === '/api/memory/scopes') {
      if (permissionsReady) {
        body = { scopes: [personalScope] };
      } else {
        status = 503;
        body = { status: 'unavailable', reason: 'permissions_applying' };
      }
    }
    await route.fulfill({ status, contentType: 'application/json',
      headers: { 'retry-after': '1', 'cache-control': 'no-store' },
      body: JSON.stringify(body) });
  }
  try {
    await page.route(`${origin}/**`, serveBuild);
    const chat = await chatFixture(page, 'private-team-draft');
    await page.route('**/api/memory/**', serveMemory);
    await page.goto(`${origin}/workspace?conversation=chat`);
    await page.locator('oc-chat-composer').waitFor();
    await page.evaluate(waitForFonts);
    if (width === 390) await page.locator('#panel-toggle').click();
    await page.getByRole('tab', { name: /Memory/u }).click();
    const waiting = page.getByRole('status').filter({ hasText: 'Setting up your memory...' });
    await waiting.waitFor();
    const bounds = await waiting.boundingBox();
    assert(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width,
      `The setup message must fit at ${width}px`);
    assert(await page.evaluate(pageHasNoOverflow), `No horizontal overflow at ${width}px`);
    await page.screenshot({ path: `${output}/waiting-${width}.png`, fullPage: true });
    permissionsReady = true;
    await page.getByText('No facts have been saved in this scope.', { exact: true }).waitFor();
    assert.equal(await waiting.count(), 0, 'The setup message must clear after recovery');
    assert(reads.length >= 3, 'The browser must retry scopes and then read facts');
    assert(reads.every(isGet), 'Setup recovery must only read');
    assert.equal(chat.commands.length, 0, 'Setup recovery must not send chat commands');
    await page.screenshot({ path: `${output}/ready-${width}.png`, fullPage: true });
  } finally {
    await page.close();
  }
}

function isGet(read) {
  return read.method === 'GET';
}

const browser = await chromium.launch();
try {
  await mkdir(output, { recursive: true });
  for (const width of [390, 1280]) {
    await checkSetup(browser, width);
  }
  console.log(`PASS Memory setup and automatic recovery at 390px and 1280px: ${output}`);
} finally {
  await browser.close();
}
