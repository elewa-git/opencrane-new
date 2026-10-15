import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { chromium } from 'playwright';

const output = resolve('docs/process/screen-p4-3-departure');
const build = resolve('apps/web/dist/web/browser');
const origin = 'https://departure.opencrane.test';
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };
const frames = { review: 'PPL-50', incomplete: 'PPL-51', removing: 'PPL-52',
  removed: 'PPL-52', unknown: 'PPL-52' };
const member = { memberId: 'alex', displayName: 'Alex Kim', email: 'alex@example.test',
  role: 'member', status: 'joined', joinedAt: '2026-03-12T10:00:00Z', groups: [],
  permissions: { changeRole: true, remove: true, manageOwnership: true },
  memberSequence: 2, ownershipSequence: 1,
  personalAssistant: { status: 'unavailable' }, rejoinedAt: { status: 'unavailable' } };
const access = { checkedAt: '2026-10-15T10:00:00Z', complete: true,
  unavailableSections: [], rows: [] };
const departure = { checkedAt: '2026-10-15T10:00:00Z', complete: true,
  unavailableSections: [], memberSequence: 2, ownershipSequence: 1,
  reviewRevision: 'a'.repeat(64), accessLost: [{ resourceType: 'model',
    resourceId: 'model-a', label: 'A shared model', relation: 'use', sources: [],
    eligibility: { person: 'allowed', assistants: [], availability: 'unavailable' } }],
  ownedSharedWork: [], routines: { status: 'absent_on_version',
    message: 'No routines can be created on this version.' },
  personalConnections: { status: 'absent_on_version',
    message: 'No personal connections can be created on this version.' },
  personalComputer: [], retainedHistory: { count: 1, firstAt: null, lastAt: null },
  permissions: { remove: true } };
const receipt = { status: 'recorded', removedAt: '2026-10-15T10:05:00Z',
  access: 'revoked', projection: { iam: 'applying', content: 'current' } };

async function serveAsset(route) {
  const pathname = new URL(route.request().url()).pathname;
  let filename = resolve(build, `.${pathname}`);
  if (!extname(pathname)) filename = resolve(build, 'index.html');
  if (!filename.startsWith(`${build}/`)) {
    await route.abort();
    return;
  }
  const body = await readFile(filename);
  await route.fulfill({ body, contentType: types[extname(filename)] ??
    'application/octet-stream' });
}

async function serve(route, scenario) {
  const pathname = new URL(route.request().url()).pathname;
  if (pathname === '/api/members/alex') {
    await route.fulfill({ json: member });
    return;
  }
  if (pathname === '/api/members/alex/access') {
    await route.fulfill({ json: access }); return;
  }
  if (pathname === '/api/members/alex/departure') {
    if (scenario === 'incomplete') {
      await route.fulfill({ json: { ...departure, complete: false,
        unavailableSections: ['inventory_index'] } });
      return;
    }
    await route.fulfill({ json: departure });
    return;
  }
  if (pathname === '/api/members/alex/remove') {
    if (scenario === 'removing') return;
    if (scenario === 'unknown') {
      await route.abort();
      return;
    }
    await route.fulfill({ json: receipt });
    return;
  }
  await serveAsset(route);
}

function readLayout() {
  let small = 0;
  const targets = globalThis.document.querySelectorAll('dialog[open] button, dialog[open] a');
  for (const target of targets) {
    const bounds = target.getBoundingClientRect();
    if (bounds.width < 44 || bounds.height < 44) small += 1;
  }
  return { small, overflow: globalThis.document.documentElement.scrollWidth > globalThis.innerWidth };
}

async function checkLayout(page) {
  const layout = await page.evaluate(readLayout);
  assert.equal(layout.small, 0);
  assert.equal(layout.overflow, false);
}

async function capture(browser, width, scenario) {
  const context = await browser.newContext({ viewport: { width, height: 900 },
    reducedMotion: 'reduce' });
  const page = await context.newPage();
  function serveScenario(route) { return serve(route, scenario); }
  await page.route('**/*', serveScenario);
  await page.goto(`${origin}/org/people/members/alex`, { waitUntil: 'domcontentloaded' });
  const opener = page.getByRole('button', { name: /Remove from/ });
  await opener.click();
  if (scenario === 'incomplete') {
    await page.getByText('The review is not complete.').waitFor();
  } else {
    await page.getByText('A shared model').waitFor();
    if (scenario !== 'review') {
      await page.getByRole('button', { name: 'Remove Alex Kim' }).click();
      if (scenario === 'removing') await page.getByText('Removing Alex Kim…').waitFor();
      if (scenario === 'removed') await page.getByText('Removed ·').waitFor();
      if (scenario === 'unknown') await page.getByText('The result is unknown.').waitFor();
    }
  }
  await checkLayout(page);
  if (scenario === 'review') {
    await page.getByRole('button', { name: 'Cancel' }).first().click();
    function isFocused(element) { return element === globalThis.document.activeElement; }
    assert.equal(await opener.evaluate(isFocused), true);
    await opener.click();
  }
  const filename = `${frames[scenario]}-${scenario}-${width}.png`;
  await page.screenshot({ path: resolve(output, filename), fullPage: true });
  await context.close();
}

await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  for (const width of [1280, 390]) {
    for (const scenario of ['review', 'incomplete', 'removing', 'removed', 'unknown']) {
      await capture(browser, width, scenario);
    }
  }
} finally { await browser.close(); }
await writeFile(resolve(output, 'receipt.md'), '# Member departure screen check\n\n'
  + 'PASS: Ten intercepted API captures at 1280px and 390px. Reduced motion, no '
  + 'horizontal overflow, controls at least 44px, and focus returns after Cancel.\n\n'
  + 'PARTIAL: No live server or fresh-install journey was run. The current status API '
  + 'does not report clean-up progress.\n');
