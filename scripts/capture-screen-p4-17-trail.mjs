/* global document, getComputedStyle */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { chatFixture } from './chat-fixture.mjs';
import { serveWebBuild } from './serve-web-build.mjs';
import { pageHasNoOverflow, waitForFonts } from './visual-helpers.mjs';

const output = resolve('docs/process/screen-p4-17-trail');
const build = resolve('apps/web/dist/web/browser');
const origin = 'https://memory-trail.opencrane.test';
const runId = 'a'.repeat(64);
const intendedAt = '2026-10-04T02:00:00.000Z';
const row = { runId, action: 'prepared', intendedAt,
  selectedAt: '2026-10-04T02:03:00.000Z',
  observedAt: '2026-10-04T02:04:00.000Z', money: { status: 'unavailable' } };
const scope = { scopeId: 'fixture-scope', scopeKind: 'group', ownerId: 'Sales team',
  audience: { kind: 'group', ownerId: 'Sales team' }, canRead: true };

async function serveMemory(route, frame, calls) {
  const request = route.request();
  const url = new URL(request.url());
  assert.equal(request.method(), 'GET');
  calls.push(url.pathname);
  let body;
  if (url.pathname === '/api/memory/scopes') body = { scopes: [scope] };
  else if (url.pathname.endsWith('/facts')) {
    body = { scopeId: scope.scopeId, facts: [], returnedCount: 0, nextCursor: null };
  } else if (url.pathname.endsWith('/maintenance')) {
    body = { status: frame === 'MEM-61' ? 'qualification_blocked' : 'preparing',
      binding: { enabled: true, memberId: 'Alex Morgan', assistantId: 'assistant',
        payingGroupId: 'Sales team', acceptedCapCents: 100 },
      nextAt: frame === 'MEM-61' ? '2026-10-05T02:00:00.000Z' : null,
      history: frame === 'MEM-61' ? [] : [row], nextCursor: null };
  } else if (url.pathname.endsWith(`/maintenance/${runId}`)) {
    body = { ...row, memberId: 'Alex Morgan', bindingRevision: 1,
      rootId: 'saved-root', allowanceCents: 100, startedAt: null };
  } else throw new Error('Unexpected memory read');
  await route.fulfill({ status: 200, contentType: 'application/json',
    headers: { 'cache-control': 'no-store' }, body: JSON.stringify(body) });
}

function reachableControls() {
  const targets = document.querySelectorAll('.maintenance button, .maintenance-detail button');
  const short = [];
  for (const target of targets) {
    const box = target.getBoundingClientRect();
    if (box.width < 44 || box.height < 44) {
      short.push({ className: target.className, width: box.width, height: box.height });
    }
  }
  return short;
}

async function capture(browser, width, frame) {
  const page = await browser.newPage({ viewport: { width, height: 900 },
    reducedMotion: 'reduce' });
  const calls = [];
  async function serveBuild(route) { await serveWebBuild(route, build); }
  async function memoryRoute(route) { await serveMemory(route, frame, calls); }
  try {
    await page.route(`${origin}/**`, serveBuild);
    await chatFixture(page, 'private-team-draft');
    await page.route('**/api/memory/**', memoryRoute);
    await page.goto(`${origin}/workspace?conversation=chat`);
    if (width === 390) await page.locator('#panel-toggle').click();
    await page.getByRole('tab', { name: /Memory/ }).click();
    if (frame === 'MEM-61') await page.getByText('No maintenance yet').waitFor();
    else {
      const opener = page.locator('.maintenance-row').first();
      await opener.click();
      const dialog = page.getByRole('dialog', { name: 'Nightly maintenance' });
      await dialog.getByText('Accepted allowance').waitFor();
      assert(await dialog.evaluate(element => element.matches(':modal')));
      assert(await dialog.locator('h2').evaluate(element => element === document.activeElement));
      await dialog.getByRole('button', { name: 'Check status' }).click();
      assert.equal(calls.filter(path => path.endsWith(runId)).length, 2);
      await page.keyboard.press('Escape');
      assert(await opener.evaluate(element => element === document.activeElement));
      await opener.focus();
      await page.keyboard.press('Enter');
      await dialog.getByText('Accepted allowance').waitFor();
      if (width === 390) {
        const box = await dialog.boundingBox();
        assert(box && box.x === 0 && box.y === 0 && box.width === 390 && box.height === 900);
      }
    }
    await page.evaluate(waitForFonts);
    assert(await page.evaluate(pageHasNoOverflow), `${frame} ${width} has overflow`);
    assert.deepEqual(await page.evaluate(reachableControls), [],
      `${frame} ${width} has short controls`);
    if (frame !== 'MEM-61') {
      const glyph = page.locator('.maintenance-glyph').first();
      assert.equal(await glyph.evaluate(element => getComputedStyle(element).animationName), 'none');
    }
    assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
    await page.screenshot({ path: resolve(output, `${frame}-${width}.png`) });
    if (width === 390 && frame !== 'MEM-61') {
      await page.locator('.maintenance-details dd').first().evaluate(function longLabel(element) {
        element.textContent = 'A very long group label with several wrapped words for a phone';
      });
      assert(await page.evaluate(pageHasNoOverflow), 'Long phone labels wrap');
      await page.setViewportSize({ width, height: 560 });
      const check = page.locator('.maintenance-check');
      await check.scrollIntoViewIfNeeded();
      const box = await check.boundingBox();
      assert(box && box.y >= 0 && box.y + box.height <= 560,
        'Check status stays reachable above a phone keyboard');
    }
  } finally { await page.close(); }
}

await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  for (const width of [1280, 390]) {
    for (const frame of ['MEM-61', 'MEM-62', 'MEM-62-RM']) {
      await capture(browser, width, frame);
    }
  }
} finally { await browser.close(); }

await writeFile(resolve(output, 'receipt.md'), `# Nightly memory trail frames

The six captures use an intercepted authorised API and reduced motion. No development
stack or paid call ran. All widths had no horizontal overflow; visible trail controls
were at least 44 pixels high and wide. The detail opened as a modal, took focus,
and returned focus to its row on Escape. Check status used the original GET.

Compared with the supplied frames, the Memory tab shows the empty trail and a
full-screen phone detail. The current API records preparation, so the detail shows
one saved preparation and its accepted allowance. It does not show the example
settled or held amounts, four fact outcomes, or source links from the illustration:
those are unavailable in this original saved reply. The reduced-motion captures
show the same static state without decorative animation.
`);
