/* global document */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { serveWebBuild } from './serve-web-build.mjs';
import { pageHasNoOverflow, waitForFonts } from './visual-helpers.mjs';

const build = resolve('apps/web/dist/web/browser');
const output = resolve('docs/process/p4-27-pr14');
const origin = 'https://overview-capture.opencrane.test';
const checkedAt = '2026-11-08T09:40:00.000Z';
const names = ['people', 'providers', 'integrations', 'spending', 'memory',
  'publication', 'routines'];

function sources(allCurrent, spendingUnavailable) {
  const result = [];
  for (const name of names) {
    let status = 'current';
    if (!allCurrent && (name === 'publication' || name === 'routines')) status = 'unavailable';
    if (spendingUnavailable && name === 'spending') status = 'unavailable';
    result.push({ name, status, checkpoint: 1, checkedAt });
  }
  return result;
}

const rows = [
  { id: 'private-one', sourceId: 'private-one', source: 'spending', priority: 'unknown',
    eventAt: checkedAt, revision: 1, action: 'view_evidence',
    href: '/api/org/effects/permit-one' },
  { id: 'private-two', sourceId: 'private-two', source: 'people', priority: 'needs_input',
    eventAt: null, revision: 1, action: 'view_invitation_links', href: '/org/people',
    affectedPeople: 'Alexandra Elizabeth Northwood and Catherine Elizabeth Southwood' },
  { id: 'private-three', sourceId: 'private-three', source: 'integrations',
    priority: 'failure', eventAt: checkedAt, revision: 1, action: 'review_tools',
    href: '/org/integrations/example' },
  { id: 'private-four', sourceId: 'private-four', source: 'providers', priority: 'ready',
    eventAt: checkedAt, revision: 1, action: 'view_evidence', href: '/org/providers/example' },
];

function response(state) {
  if (state.revoked) return { status: 403, body: JSON.stringify({ status: 'refused' }) };
  if (state.failed) return { status: 503, body: JSON.stringify({ status: 'unavailable' }) };
  let currentRows = rows;
  if (state.empty) currentRows = [];
  if (state.sourceOutage) currentRows = rows.slice(1);
  const body = { rows: currentRows, next: null, allClear: state.empty,
    sources: sources(state.allCurrent, state.sourceOutage), viewer: { role: 'admin' },
    capabilities: {} };
  return { status: 200, body: JSON.stringify(body) };
}

async function serve(route, state) {
  const path = new URL(route.request().url()).pathname;
  if (path === '/api/org/overview') {
    const reply = response(state);
    await route.fulfill({ ...reply, contentType: 'application/json' });
    return;
  }
  if (path.startsWith('/api/')) throw new Error(`Unexpected API request: ${path}`);
  await serveWebBuild(route, build);
}

function touchTargets() {
  const targets = document.querySelectorAll('.overview button, .overview a');
  for (const target of targets) {
    const box = target.getBoundingClientRect();
    if (box.width < 44 || box.height < 44) return false;
  }
  return true;
}

function isFocused(element) {
  return element === document.activeElement;
}

async function capture(page, name, width) {
  await page.evaluate(waitForFonts);
  assert(await page.evaluate(pageHasNoOverflow), `${name} has no horizontal overflow`);
  assert(await page.evaluate(touchTargets), `${name} has 44 px action targets`);
  await page.screenshot({ path: resolve(output, `${name}-${width}.png`), fullPage: true });
}

async function show(browser, width, name) {
  const state = { empty: name === 'OVR-02' || name === 'OVR-02-fresh',
    allCurrent: name === 'OVR-02',
    sourceOutage: name === 'OVR-06',
    failed: false, revoked: false };
  const page = await browser.newPage({ viewport: { width, height: 900 },
    reducedMotion: 'reduce' });
  async function routeRequest(route) {
    await serve(route, state);
  }
  try {
    await page.route(`${origin}/**`, routeRequest);
    await page.goto(`${origin}/org/overview`);
    if (name === 'OVR-05') {
      await page.locator('.overview-row').first().waitFor();
      state.failed = true;
      await page.getByRole('button', { name: 'Refresh list' }).click();
      await page.getByText('Showing what we loaded at', { exact: false }).waitFor();
    } else if (name === 'OVR-06-revoked') {
      await page.locator('.overview-row').first().waitFor();
      state.revoked = true;
      await page.getByRole('button', { name: 'Refresh list' }).click();
      await page.getByText('Access changed').waitFor();
    } else if (name === 'OVR-02') {
      await page.getByText('Nothing needs your attention').waitFor();
      assert(await page.locator('.overview-notice.setup a').isVisible(),
        'OVR-02 shows setup beside the dated clear notice');
    } else if (name === 'OVR-02-fresh') {
      await page.getByText('Start by connecting a model provider').waitFor();
    } else {
      await page.locator('.overview-row').first().waitFor();
    }
    if (name === 'OVR-01') {
      assert(await page.locator('.overview-ready .overview-row').count() === 1,
        'OVR-01 keeps Ready in its own evidence section');
      await page.getByRole('button', { name: 'Refresh list' }).focus();
      await page.keyboard.press('Tab');
      assert(await page.locator('.overview-row').first().evaluate(isFocused),
        'Tab reaches a task row');
      await page.keyboard.press('Tab');
      assert(await page.locator('.overview-row a').first().evaluate(isFocused),
        'Tab reaches its action');
    }
    if (name === 'OVR-05') {
      assert(await page.locator('.overview-notice.stale button').isVisible(),
        'OVR-05 keeps Refresh in the stale notice');
    }
    if (name === 'OVR-02' && width === 390) {
      const setupLink = await page.locator('.overview-notice.setup a').boundingBox();
      assert(setupLink && setupLink.width >= 280,
        'OVR-02 setup action fills the phone notice');
    }
    await capture(page, name, width);
  } finally {
    await page.close();
  }
}

await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  for (const width of [1280, 390]) {
    for (const name of [
      'OVR-01', 'OVR-02', 'OVR-02-fresh', 'OVR-05', 'OVR-06', 'OVR-06-revoked',
    ]) {
      await show(browser, width, name);
    }
  }
} finally {
  await browser.close();
}
await writeFile(resolve(output, 'receipt.md'),
  '# Overview screen capture\n\nPASS — Twelve intercepted browser captures at 1280 and 390 pixels. '
  + 'Reduced motion, horizontal overflow and 44 px actions checked. '
  + 'No live stack was used.\n');
