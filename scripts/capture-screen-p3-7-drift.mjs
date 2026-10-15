import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { chromium } from 'playwright';

const output = resolve('docs/process/screen-p3-7-drift');
const build = resolve('apps/web/dist/web/browser');
const origin = 'https://drift.opencrane.test';
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };
const checkedAt = '2026-10-15T08:40:00.000Z';
const expiresAt = '2026-10-15T08:45:00.000Z';
const captureTime = Date.now();
const freshCheckedAt = new Date(captureTime - 60_000).toISOString();
const freshExpiresAt = new Date(captureTime + 240_000).toISOString();
let stalePolicyReads = 0;

function declaration(name, revision, description, inputSchema) {
  const definition = JSON.stringify({ name, description, inputSchema });
  return { name, revision: revision.repeat(64), reviewed: false, definition };
}

const before = [
  declaration('read_draft_order', 'a', 'Reads one draft order', { type: 'object' }),
  declaration('update_draft_order_note', 'b', 'Updates a draft order note',
    { type: 'object', properties: { note: { type: 'string', maxLength: 500 } } }),
  declaration('list_partners', 'c', 'Read partner names', { type: 'object' }),
];
const after = [before[0], declaration('update_draft_order_note', 'd',
  'Updates a draft order note', { type: 'object', properties: {
    note: { type: 'string', maxLength: 2000 }, internal: { type: 'boolean' },
  } }), declaration('confirm_draft_order', 'e', 'Confirms a draft order',
    { type: 'object' })];

function catalogue(tools, digest, checkTime, expiryTime) {
  return { serverId: 'odoo', toolCount: tools.length, schemaDigest: digest.repeat(64),
    checkedAt: checkTime, expiresAt: expiryTime, tools };
}

function policy(scenario) {
  const driftHeld = scenario !== 'INT-42';
  let current = driftHeld ? after : before;
  if (scenario === 'LONG') {
    current = [declaration('x'.repeat(2000), '3', 'A long name', { type: 'object' })];
  }
  const checkTime = driftHeld ? freshCheckedAt : checkedAt;
  const expiryTime = driftHeld ? freshExpiresAt : expiresAt;
  return { silo: null, serverId: 'odoo', connectionId: 'odoo-connection',
    accountMode: 'none', published: false, driftHeld, sequence: 4, policyRevision: 3,
    catalogue: catalogue(current, driftHeld ? 'f' : '1', checkTime, expiryTime),
    previousCatalogue: driftHeld ? catalogue(before, '2', checkTime, expiryTime) : null,
    checkedAt: checkTime, expiresAt: scenario === 'INT-42' ? null : expiryTime,
    tools: current.map((tool) => ({ name: tool.name, revision: tool.revision,
      reviewed: tool.name === 'read_draft_order', readOnly: true,
      mode: tool.name === 'read_draft_order' ? 'allow' : 'block', suggestion: 'allow' })),
  };
}

const register = { loadedAt: checkedAt, rows: [{ serverId: 'odoo',
  name: 'Odoo Community', version: 'Version not provided',
  source: { kind: 'remote_url', label: 'Remote URL', detail: 'odoo.example.test' },
  accountModel: 'None', toolsAllowed: 1, toolsTotal: 3,
  status: { kind: 'needs_input', label: 'Needs input', detail: 'Tool review needed' } }] };

async function serve(route, scenario) {
  const pathname = new URL(route.request().url()).pathname;
  if (pathname === '/auth/me') {
    await route.fulfill({ json: { authenticated: true,
      user: { email: 'owner@example.test', role: 'Owner' } } });
    return;
  }
  if (pathname === '/api/org/integrations') {
    await route.fulfill({ json: register });
    return;
  }
  if (pathname === '/api/org/integrations/odoo/tools') {
    if (scenario === 'INT-41-policy-failed' ||
        (scenario === 'INT-41-policy-stale' && stalePolicyReads > 0)) {
      await route.fulfill({ status: 503, json: { status: 'unavailable' } });
      return;
    }
    if (scenario === 'INT-41-policy-stale') stalePolicyReads += 1;
    await route.fulfill({ json: policy(scenario) });
    return;
  }
  if (pathname.startsWith('/api/')) {
    await route.fulfill({ status: 404, json: { status: 'missing' } });
    return;
  }
  let filename = resolve(build, `.${pathname}`);
  if (!extname(pathname)) filename = resolve(build, 'index.html');
  if (!filename.startsWith(`${build}/`)) {
    await route.abort();
    return;
  }
  const body = await readFile(filename);
  await route.fulfill({ body, contentType: types[extname(filename)] ?? 'application/octet-stream' });
}

async function checkLayout(page, width, scenario) {
  const overflow = await page.evaluate(() =>
    globalThis.document.documentElement.scrollWidth > globalThis.innerWidth);
  assert.equal(overflow, false, `${scenario} at ${width}px has no horizontal scroll`);
  if (width !== 390) return;
  const menu = page.locator('.mobile-bar button');
  const menuBounds = await menu.boundingBox();
  assert(menuBounds && menuBounds.height >= 44 && menuBounds.width >= 44);
  const actions = page.locator('main .actions .button');
  const count = await actions.count();
  for (let index = 0; index < count; index += 1) {
    const bounds = await actions.nth(index).boundingBox();
    assert(bounds && bounds.height >= 44, `${scenario} action has a 44px target`);
  }
  if (scenario === 'INT-41' || scenario === 'INT-41-policy-stale') {
    const labels = page.locator('.change-row h3');
    assert.equal(await labels.count(), 12);
  }
}

async function capture(browser, scenario, width) {
  stalePolicyReads = 0;
  const context = await browser.newContext({ viewport: { width, height: 900 },
    reducedMotion: 'reduce' });
  const page = await context.newPage();
  const serveScenario = (route) => serve(route, scenario);
  await page.route(`${origin}/**`, serveScenario);
  const suffix = scenario.startsWith('INT-41') ? '/changes' : '';
  try {
    await page.goto(`${origin}/org/integrations/odoo${suffix}`);
    if (scenario === 'INT-41-policy-stale') {
      await page.locator('.change-row').first().waitFor();
      await page.locator('#integration-refresh').click();
    }
    const expected = scenario === 'INT-42' ? 'Last check expired' :
      scenario.includes('policy-') ? "Couldn't check the tool policy" :
        scenario === 'INT-41' ? 'Review changed tools' : 'is paused: its tools changed';
    await page.getByText(expected, { exact: false }).first().waitFor();
    if (scenario === 'INT-41-policy-failed') {
      assert.equal(await page.getByText('Review tools', { exact: true }).count(), 0);
    }
    if (scenario === 'INT-41') {
      const comparison = await page.locator('.changes-list').innerText();
      assert.match(comparison, /maxLength: 500/);
      assert.match(comparison, /maxLength: 2000/);
      assert.match(comparison, /internal: boolean/);
    }
    if (scenario === 'INT-41-policy-stale') {
      await page.getByText('Showing rows from the last successful read',
        { exact: false }).waitFor();
    }
    await page.evaluate(() => globalThis.document.fonts.ready);
    await checkLayout(page, width, scenario);
    await page.screenshot({ path: resolve(output, `${scenario}-${width}.png`), fullPage: true });
  } finally {
    await context.close();
  }
}

async function checkLongName(browser) {
  const context = await browser.newContext({ viewport: { width: 390, height: 900 },
    reducedMotion: 'reduce' });
  const page = await context.newPage();
  const serveLongName = (route) => serve(route, 'LONG');
  await page.route(`${origin}/**`, serveLongName);
  try {
    await page.goto(`${origin}/org/integrations/odoo/changes`);
    await page.locator('.change-row').first().waitFor();
    const overflow = await page.evaluate(() =>
      globalThis.document.documentElement.scrollWidth > globalThis.innerWidth);
    assert.equal(overflow, false, 'A 2,000-character tool name wraps without horizontal scroll');
  } finally {
    await context.close();
  }
}

await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  for (const scenario of ['INT-40', 'INT-41', 'INT-42',
    'INT-41-policy-failed', 'INT-41-policy-stale']) {
    for (const width of [1280, 390]) await capture(browser, scenario, width);
  }
  await checkLongName(browser);
} finally {
  await browser.close();
}
await writeFile(resolve(output, 'receipt.md'), `# Paused integration screens

PASS: Captured ten intercepted screens at 1280px and 390px with reduced motion.
PASS: Checked horizontal overflow, the phone menu target, action targets and phone row labels.
PASS: Checked that the comparison shows the old 500 and new 2000 character limits and the new internal field.
PASS: Captured a failed first policy read without a Review tools link and a failed refresh with dated retained rows.
NOT RUN: Live installation and fresh catalogue checks.

The detail page uses the saved tool policy because no changes read is available yet.
The changed tools page links to the current tool review route. It says that restoring
calls is not available yet. The expired check screen has no check action because the
current API cannot start one. Connection and grant facts use the current API's
availability wording.
`);
