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
    newRole: 'owner', actor: { kind: 'person', id: 'member-Marie' } },
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
    if (box.width < 44 || box.height < 44) return false;
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
      await page.getByRole('button', { name: 'Apply filters' }).click();
      await page.getByText('No history matches this selection.').waitFor();
    } else {
      await page.locator('.row-button').first().waitFor();
    }
    if (frame === 'OVR-22') {
      await page.locator('.row-button').first().click();
      await page.locator('.evidence').first().waitFor();
    }
    await page.evaluate(waitForFonts);
    assert(await page.evaluate(pageHasNoOverflow), `${frame} ${width} overflow`);
    assert(await page.evaluate(touchTargets), `${frame} ${width} touch targets`);
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
  + 'Reduced motion, horizontal overflow and 44 px targets were checked. '
  + 'No live stack was used.\n\n'
  + 'PARTIAL — Compared with the six OVR-20/21/22 handoff frames. The list and '
  + 'detail use the same broad layout and phone panel. The captures show safe event '
  + 'references in place of unavailable permitted names, and the existing server '
  + 'filter controls take more space than the handoff. No page count is claimed.\n');
