import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { chatFixture } from './chat-fixture.mjs';
import { serveWebBuild } from './serve-web-build.mjs';
import { pageHasNoOverflow, waitForFonts } from './visual-helpers.mjs';

const origin = 'https://p4-12-memory.opencrane.test';
const output = resolve('docs/process/p4-12-memory/captures');
const build = resolve('apps/web/dist/web/browser');
const fact = {
  memoryId: 'fact-one', revision: 4, text: 'The quarterly planning session is usually held on Thursday.',
  kind: 'fact', pinned: false, expiresAt: null, savedAt: '2026-10-02T10:00:00Z',
};
const groupScope = {
  scopeId: 'scope-group', scopeKind: 'group', ownerId: 'opaque-sales',
  audience: { kind: 'group', ownerId: 'opaque-sales' }, canRead: true,
};

async function serveBuild(route) {
  await serveWebBuild(route, build);
}

async function serveMemory(page) {
  await page.route('**/api/memory/**', async route => {
    const url = new URL(route.request().url());
    let body;
    if (url.pathname === '/api/memory/scopes') {
      body = { scopes: [
        { scopeId: 'scope-person', scopeKind: 'person', ownerId: 'me',
          audience: { kind: 'person', ownerId: 'me' }, canRead: true },
        groupScope,
        { scopeId: 'scope-assistant', scopeKind: 'assistant_notes', ownerId: 'assistant',
          audience: { kind: 'group', ownerId: 'opaque-sales' }, canRead: true },
      ] };
    } else if (url.pathname.endsWith('/facts/fact-one')) {
      body = { scopeId: groupScope.scopeId, fact, sources: [
        { status: 'available', label: 'Quarterly planning conversation',
          reference: { conversationId: 'chat', messageId: 'message-one' } },
      ] };
    } else {
      body = { scopeId: groupScope.scopeId, facts: [fact], returnedCount: 1,
        nextCursor: null };
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body),
      headers: { 'cache-control': 'no-store' } });
  });
}

async function openMemoryDetail(page, width) {
  if (width === 390) await page.locator('#panel-toggle').click();
  await page.getByRole('tab', { name: /Memory/ }).click();
  await page.getByRole('button', { name: 'Group memory' }).click();
  await page.getByRole('button', { name: /quarterly planning session/ }).click();
  await page.getByRole('dialog', { name: 'Fact details' }).waitFor();
  await page.getByText('Revision', { exact: true }).waitFor();
  await page.locator('dialog.detail .audience').filter({
    hasText: 'Shared with group opaque-sales',
  }).waitFor();
}

async function capture(browser, width, motion) {
  const height = width === 1280 ? 900 : 844;
  const page = await browser.newPage({ viewport: { width, height }, reducedMotion: motion });
  try {
    await page.route(`${origin}/**`, serveBuild);
    const fixture = await chatFixture(page, 'private-team-draft');
    await serveMemory(page);
    await page.goto(`${origin}/workspace?conversation=chat`);
    await page.locator('oc-chat-composer').waitFor();
    await page.evaluate(waitForFonts);
    await openMemoryDetail(page, width);
    assert(await page.evaluate(pageHasNoOverflow), `No horizontal overflow at ${width}px`);
    const motionName = motion === 'reduce' ? '-RM' : '';
    const filename = `MEM-03-${width}${motionName}.png`;
    await page.screenshot({ path: `${output}/${filename}`, fullPage: true });
    return { filename, commands: fixture.commands.length };
  } finally {
    await page.close();
  }
}

const browser = await chromium.launch();
try {
  await mkdir(output, { recursive: true });
  const captures = [];
  for (const width of [1280, 390]) {
    for (const motion of ['no-preference', 'reduce']) {
      captures.push(await capture(browser, width, motion));
    }
  }
  assert(captures.every(captureResult => captureResult.commands === 0),
    'Opening memory detail must not send a chat command');
  await writeFile(`${output}/visual.json`, `${JSON.stringify({
    result: 'PASS', widths: [1280, 390], reducedMotion: true,
    checks: ['Detail audience and fact metadata are visible.',
      'The detail uses its own modal and fits both viewports.',
      'Opening memory detail sends no chat command.'],
    captures: captures.map(captureResult => captureResult.filename),
  }, null, 2)}\n`);
  console.log(`PASS Memory detail captures: ${captures.length}`);
} finally {
  await browser.close();
}
