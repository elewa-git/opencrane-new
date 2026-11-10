/* global document */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { serveWebBuild } from './serve-web-build.mjs';
import { pageHasNoOverflow, waitForFonts } from './visual-helpers.mjs';

const build = resolve('apps/web/dist/web/browser');
const output = resolve('docs/process/screen-p4-27-history');
const origin = 'https://history-capture.opencrane.test';
const recordedAt = '2026-11-08T10:50:00.000Z';

const facts = [
  { id: 'change-owner', type: 'member.role_changed', operation: 'appointment',
    newRole: 'owner', actor: { kind: 'person', id: 'member-Marie' },
    progress: { readModel: 'current', iam: 'current', checkedAt: recordedAt } },
  { id: 'child-published', type: 'conversation.child_result_published',
    publicationKind: 'interim', parentConversationId: 'parent',
    taskHref: '/workspace?conversation=parent' },
  { id: 'delegation-outcome-with-a-long-safe-reference-2026-11-08', type: 'delegation.completed',
    delegationAccess: 'restricted', joinStatus: 'unavailable' },
  { id: 'memory-maintenance', type: 'memory.maintenance_recorded',
    maintenanceAction: 'prepared', maintenanceScopeKind: 'person' },
  { id: 'unknown-effect', type: 'effect.dispatched' },
];

function record(fact, position) {
  const { id, ...metadata } = fact;
  return { eventId: id, position,
    source: 'authoritative', status: fact.id === 'unknown-effect' ? 'unknown' : 'recorded',
    recordedAt, ...metadata };
}

function rows() {
  return facts.map((fact, index) => ({
    id: fact.id, decision: fact.id === 'unknown-effect' ? 'allow' : 'not_recorded',
    outcome: fact.id === 'unknown-effect' ? 'unknown' : 'recorded',
    records: [record(fact, facts.length - index)],
  }));
}

async function serve(route, empty) {
  const url = new URL(route.request().url());
  if (url.pathname === '/api/org/history') {
    const reply = { rows: empty ? [] : rows() };
    await route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify(reply) });
    return;
  }
  if (url.pathname.startsWith('/api/org/history/')) {
    const id = decodeURIComponent(url.pathname.slice('/api/org/history/'.length));
    const selected = rows().find(row => row.id === id);
    assert(selected, 'detail reads a selected audit id');
    await route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ id, records: selected.records }) });
    return;
  }
  if (url.pathname.startsWith('/api/')) throw new Error('Unexpected API read');
  await serveWebBuild(route, build);
}

function touchTargets() {
  const targets = document.querySelectorAll('.history button, .history a, .history-detail button');
  for (const target of targets) {
    const box = target.getBoundingClientRect();
    if (box.width < 44 || box.height < 44) {
      throw new Error(`${target.textContent?.trim()} ${box.width}x${box.height}`);
    }
  }
  return true;
}

async function capture(browser, width, frame) {
  const empty = frame === 'OVR-21';
  const page = await browser.newPage({ viewport: { width, height: 900 },
    reducedMotion: 'reduce' });
  async function routeRequest(route) { await serve(route, empty); }
  try {
    await page.route(`${origin}/**`, routeRequest);
    await page.goto(`${origin}/org/history`);
    if (empty) {
      await page.getByRole('searchbox', { name: 'Safe reference' }).fill('chg_ZZZZ');
      await page.getByRole('button', { name: 'Search' }).click();
      await page.getByText('No entries match chg_ZZZZ.').waitFor();
    } else {
      await page.locator('.row-button').first().waitFor();
    }
    if (frame === 'OVR-22') {
      const opener = page.locator('.row-button').first();
      await opener.click();
      await page.locator('.evidence').first().waitFor();
      assert(await page.locator('.history-detail').evaluate(dialog => dialog.matches(':modal')),
        'detail uses a browser modal');
      assert(await page.locator('#history-detail-title').evaluate(title => title === document.activeElement),
        'detail title receives focus');
      await page.keyboard.press('Shift+Tab');
      assert(await page.locator('.history-detail').evaluate(dialog => dialog.contains(document.activeElement)),
        'reverse Tab stays in detail');
      await page.keyboard.press('Tab');
      assert(await page.locator('.history-detail').evaluate(dialog => dialog.contains(document.activeElement)),
        'Tab stays in detail');
      await page.keyboard.press('Escape');
      assert(await opener.evaluate(button => button === document.activeElement),
        'Escape returns focus to the opener');
      await opener.click();
      await page.locator('.evidence').first().waitFor();
    }
    await page.evaluate(waitForFonts);
    assert(await page.evaluate(pageHasNoOverflow), `${frame} ${width} overflow`);
    assert(await page.evaluate(touchTargets), `${frame} ${width} touch targets`);
    if (width === 390 && frame !== 'OVR-22') {
      const result = frame === 'OVR-21' ? '.empty-card' : '.row-button';
      const top = await page.locator(result).first().evaluate(element =>
        element.getBoundingClientRect().top);
      assert(top < 900, `${frame} phone result visible without scrolling`);
    }
    if (width === 390 && frame === 'OVR-22') {
      const dialog = await page.locator('.history-detail').boundingBox();
      assert(dialog && dialog.x === 0 && dialog.y === 0 &&
        dialog.width === width && dialog.height === 900,
        'phone detail covers the whole viewport');
      const action = await page.getByRole('link', { name: 'Open People & groups' }).boundingBox();
      assert(action && action.width >= width - 32,
        'phone detail action spans the available width');
    }
    await page.screenshot({ path: resolve(output, `${frame}-${width}.png`) });
  } finally {
    await page.close();
  }
}

await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  for (const width of [1280, 390]) {
    for (const frame of ['OVR-20', 'OVR-21', 'OVR-22']) {
      await capture(browser, width, frame);
    }
  }
} finally {
  await browser.close();
}
await writeFile(resolve(output, 'receipt.md'),
  '# Change history screen capture\n\n'
  + 'PASS — Six intercepted browser captures at 1280 and 390 pixels. '
  + 'The list includes membership, publication, restricted delegation, memory metadata '
  + 'and an unknown observation. OVR-21 shows an empty selection; OVR-22 shows detail. '
  + 'Reduced motion, horizontal overflow, 44 px targets and visible phone results were checked. '
  + 'The detail was checked for modal focus, Tab, reverse Tab, Escape and focus return. '
  + 'The 390 px detail covers the viewport and its action spans the available width. '
  + 'No live stack was used.\n\n'
  + 'PARTIAL — Frame comparison is visual and has no pixel comparison gate. '
  + 'The server does not supply display names or an organisation name for these records. '
  + 'The captures use readable generic labels for verified people and scope. '
  + 'No page count is claimed.\n');
