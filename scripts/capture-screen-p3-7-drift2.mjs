import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { chromium } from 'playwright';

const output = resolve('docs/process/screen-p3-7-drift2');
const build = resolve('apps/web/dist/web/browser');
const origin = 'https://drift2.opencrane.test';
const checkedAt = new Date(Date.now() - 60_000).toISOString();
const expiresAt = new Date(Date.now() + 239_000).toISOString();
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };

function tool(name, letter, schema) {
  return { name, revision: letter.repeat(64), reviewed: false, costCents: 0,
    definition: JSON.stringify({ name, inputSchema: schema }) };
}
const before = [tool('update_note', 'a', { type: 'object', properties: {
  note: { type: 'string', maxLength: 500 },
} })];
const after = [tool('update_note', 'b', { type: 'object', properties: {
  note: { type: 'string', maxLength: 2000 }, internal: { type: 'boolean' },
} }), tool('confirm_order', 'c', { type: 'object' })];
function catalogue(tools, letter) {
  return { serverId: 'fixture-server', toolCount: tools.length,
    schemaDigest: letter.repeat(64), checkedAt, expiresAt, tools };
}
const policy = { silo: 'test', serverId: 'fixture-server', connectionId: 'connection',
  accountMode: 'none', published: false, driftHeld: true, sequence: 8, policyRevision: 7,
  checkedAt, expiresAt, previousCatalogue: catalogue(before, 'd'),
  catalogue: catalogue(after, 'e'), tools: [
    { name: 'update_note', revision: 'b'.repeat(64), reviewed: false, readOnly: false,
      mode: 'ask', suggestion: 'ask', costCents: 0 },
    { name: 'confirm_order', revision: 'c'.repeat(64), reviewed: false, readOnly: false,
      mode: 'block', suggestion: 'ask', costCents: 0 },
  ] };
const register = { loadedAt: checkedAt, rows: [{ serverId: 'fixture-server',
  name: 'Fixture server', version: '1', accountModel: 'None', toolsAllowed: 0,
  toolsTotal: 2, source: { kind: 'remote_url', label: 'Remote URL', detail: 'example.test' },
  status: { kind: 'needs_input', label: 'Needs input', detail: 'Tools changed' } }] };

async function serve(route, scenario) {
  const request = route.request();
  const pathname = new URL(request.url()).pathname;
  if (pathname === '/auth/me') {
    await route.fulfill({ json: { authenticated: true,
      user: { email: 'owner@example.test', role: 'Owner' } } });
    return;
  }
  if (pathname === '/api/org/integrations') {
    await route.fulfill({ json: register });
    return;
  }
  if (pathname === '/api/org/integrations/fixture-server/tools') {
    await route.fulfill({ json: policy });
    return;
  }
  if (pathname === '/api/org/integrations/fixture-server/publication' &&
      request.method() === 'GET') {
    const status = scenario === 'pending'
      ? { status: 'applying', changeRef: 'chg_fixture', stage: 'observation' }
      : { status: 'disabled' };
    await route.fulfill({ json: status });
    return;
  }
  if (pathname.endsWith('/review') && request.method() === 'POST') {
    await route.fulfill({ status: 409, json: { status: 'conflict' } });
    return;
  }
  if (pathname.startsWith('/api/')) {
    await route.fulfill({ status: 404, json: { status: 'unknown' } });
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

async function capture(browser, scenario, width) {
  const context = await browser.newContext({ viewport: { width, height: 900 },
    reducedMotion: 'reduce' });
  const page = await context.newPage();
  const handle = (route) => serve(route, scenario);
  await page.route(`${origin}/**`, handle);
  try {
    await page.goto(`${origin}/org/integrations/fixture-server/changes`);
    await page.getByText('maxLength: 2000', { exact: false }).first().waitFor();
    if (scenario === 'conflict') {
      await page.getByRole('button', { name: 'Review and publish' }).click();
      await page.getByText('Review again', { exact: false }).first().waitFor();
    }
    if (scenario === 'pending') {
      await page.getByText('Publishing the reviewed tool list', { exact: false }).first().waitFor();
    }
    await page.evaluate(() => globalThis.document.fonts.ready);
    const overflow = await page.evaluate(() =>
      globalThis.document.documentElement.scrollWidth > globalThis.innerWidth);
    assert.equal(overflow, false, `${scenario} ${width}: horizontal scroll`);
    if (width === 390) {
      const buttons = page.locator('main button');
      for (let index = 0; index < await buttons.count(); index += 1) {
        const box = await buttons.nth(index).boundingBox();
        assert(box && box.height >= 44, `${scenario}: short phone control`);
      }
      assert.equal(await page.locator('.change-row h3').count(), 6);
    }
    await page.screenshot({ path: resolve(output, `INT-43-${scenario}-${width}.png`),
      fullPage: true });
  } finally {
    await context.close();
  }
}

await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  for (const scenario of ['pending', 'review', 'conflict']) {
    for (const width of [1280, 390]) await capture(browser, scenario, width);
  }
} finally {
  await browser.close();
}
await writeFile(resolve(output, 'receipt.md'),
  '# Changed tool review capture\n\n' +
  'PASS: intercepted pending, review and conflict screens at 1280 and 390 px. ' +
  'Phone controls were at least 44 px high, with no horizontal page scroll. ' +
  'The captures use fixed API replies. Live acknowledgement: NOT RUN.\n');
