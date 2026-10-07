import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { chromium } from 'playwright';

const output = resolve('docs/process/f3-org-shell');
const build = resolve('apps/web/dist/web/browser');
const origin = 'https://f3.opencrane.test';
const captures = [];
const destinations = [
  ['overview', 'Overview'], ['people', 'People & groups'], ['models', 'Models & providers'],
  ['spending', 'Spending'], ['integrations', 'Integrations'], ['routines', 'Routines'],
  ['history', 'Change history'],
];
const contentTypes = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.woff2': 'font/woff2', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
};
// Disposable read fixtures qualify the shell, never a live organisation or its grants.
const integrations = {
  loadedAt: '2026-10-04T08:40:00Z',
  rows: [{
    serverId: 'odoo', name: 'Odoo Community', version: '17.0.4',
    source: { kind: 'remote_url', label: 'Remote URL', detail: 'odoo.example.test' },
    accountModel: 'Company', toolsAllowed: 2, toolsTotal: 2,
    status: { kind: 'ready', label: 'Available to the assistant', detail: 'Published' },
  }],
};
const budget = {
  sequence: 2, defaultPayingGroupId: 'personal-default', periodStart: '2026-10-01T00:00:00Z',
  todayCents: 1, monthCents: 1, reservedCents: 25, ceilingCents: 20000,
  dailyCeilingCents: 2000, ceilings: [],
};

async function interceptAssets(route) {
  const url = new URL(route.request().url());
  let filename = resolve(build, `.${url.pathname}`);
  if (!extname(url.pathname)) {
    filename = resolve(build, 'index.html');
  }
  if (!filename.startsWith(`${build}/`)) {
    return route.abort();
  }
  const body = await readFile(filename);
  const contentType = contentTypes[extname(filename)] ?? 'application/octet-stream';
  const response = { body, contentType };
  await route.fulfill(response);
}

async function readFixture(route) {
  const pathname = new URL(route.request().url()).pathname;
  let json = {};
  if (pathname === '/api/org/integrations') {
    json = integrations;
  }
  if (pathname === '/api/org/providers') {
    json = { rows: [{ providerId: 'fixture-provider', provider: 'openai',
      name: 'Pinned model provider', revision: 1, position: 1,
      enabledModels: ['pinned-model'], status: 'saved_unverified' }],
      loadedAt: '2026-10-04T08:40:00Z',
      access: { grantsAvailable: false, reason: 'p4_22_required' } };
  }
  if (pathname === '/api/org/models') {
    json = { budget, models: [{ id: 'pinned-model' }, { id: 'retired-model', retired: true }],
      taskRouting: { chat_turn: { model: 'pinned-model', reason: 'Chat' } } };
  }
  if (pathname.endsWith('/tools')) {
    json = {
      tools: [], connectionId: null, accountMode: null, published: false, sequence: 0,
    };
  }
  if (pathname.endsWith('/history')) {
    json = { rows: [] };
  }
  const response = { json };
  await route.fulfill(response);
}

function focused(node) {
  return node === globalThis.document.activeElement;
}

function fitsViewport(node) {
  return node.scrollWidth <= node.clientWidth;
}

function ring(node) {
  const style = globalThis.getComputedStyle(node);
  return [style.outlineWidth, style.outlineColor, style.outlineOffset];
}

function animation(node) {
  return globalThis.getComputedStyle(node).animationName;
}

async function fontsReady() {
  await globalThis.document.fonts.ready;
}

async function settle(node) {
  const animations = node.getAnimations();
  for (const animation of animations) {
    await animation.finished;
  }
}

async function capture(page, name, width, motion) {
  assert(await page.locator('html').evaluate(fitsViewport), 'No horizontal overflow');
  const filename = `${name}-${width}-${motion}.png`;
  const options = { path: `${output}/${filename}`, fullPage: true };
  await page.screenshot(options);
  captures.push(filename);
}

async function checkNavigation(page, width, motion) {
  const sidebar = page.locator('.sidebar');
  if (width === 1280) {
    const box = await sidebar.boundingBox();
    assert.equal(box.width, 220, '220px organisation sidebar');
    assert.equal(box.x, 0);
  }
  let navigation = sidebar.locator('nav');
  let menu;
  const opener = page.getByRole('button', { name: 'Open organisation navigation' });
  if (width === 390) {
    const box = await opener.boundingBox();
    assert(box.width >= 44 && box.height >= 44);
    await opener.focus();
    await page.keyboard.press('Enter');
    menu = page.getByRole('dialog', { name: 'Organisation settings', exact: true });
    const title = menu.locator('h2');
    assert(await title.evaluate(focused), 'Menu starts on its title');
    const expected = motion === 'reduce' ? 'none' : 'oc-menu-hinge';
    assert.equal(await menu.evaluate(animation), expected);
    await menu.evaluate(settle);
    assert.equal((await menu.boundingBox()).width, 390);
    navigation = menu.locator('nav');
  }
  const links = navigation.locator('a');
  for (let index = 0; index < destinations.length; index++) {
    const [id, label] = destinations[index];
    const link = links.nth(index);
    const text = await link.textContent();
    assert.equal(text.trim(), label);
    assert.equal(await link.getAttribute('href'), `/org/${id}`);
    if (width === 390) {
      assert((await link.boundingBox()).height >= 44);
    }
  }
  assert.equal(await navigation.locator('[aria-current="page"]').count(), 1);
  if (menu) {
    const first = links.first();
    await first.focus();
    assert.deepEqual(await first.evaluate(ring), ['2px', 'rgb(10, 132, 151)', '2px']);
    await page.keyboard.press('ArrowDown');
    assert(await links.nth(1).evaluate(focused));
    await page.keyboard.press('End');
    const back = links.last();
    assert.equal(await back.getAttribute('href'), '/workspace');
    assert(await back.evaluate(focused));
    await page.keyboard.press('Tab');
    const close = menu.getByRole('button', { name: 'Close navigation' });
    assert(await close.evaluate(focused), 'Tab wraps inside the menu');
    await capture(page, 'menu', width, motion);
    await page.keyboard.press('Escape');
    await menu.waitFor({ state: 'hidden' });
    assert(await opener.evaluate(focused), 'Escape returns to the opener');
  }
}

async function checkRowLabels(register, width) {
  const row = register.getByRole('listitem');
  for (const label of ['Server:', 'Account:', 'Tools:', 'Status:']) {
    assert((await row.textContent()).includes(label), `Register names ${label}`);
  }
  if (width === 390) {
    await row.getByText('Status:', { exact: true }).waitFor({ state: 'visible' });
  }
}

async function checkModelStatus(page) {
  const spendingLink = page.locator('oc-models').getByRole('link', { name: 'Spending' });
  assert((await spendingLink.boundingBox()).height >= 44, 'Spending target is at least 44px');
  await page.getByRole('heading', { name: 'Models & providers', exact: true }).waitFor();
  assert.equal(await page.locator('time').count(), 0, 'No invented evidence date');
  await page.getByText('pinned-model', { exact: true }).waitFor();
  await page.getByText('Not available yet', { exact: true }).first().waitFor();
  assert.equal(await page.getByText('retired-model', { exact: true }).count(), 0,
    'Retired models are not offered');
}

async function checkPages(page, width, motion) {
  await page.goto(`${origin}/org/integrations`);
  await page.locator('.register-row').waitFor();
  const register = page.getByRole('list', { name: 'Integrations', exact: true });
  assert.equal(await register.getByRole('listitem').count(), 1, 'Semantic register rows');
  await page.evaluate(fontsReady);
  await checkRowLabels(register, width);
  await capture(page, 'integrations', width, motion);
  await checkNavigation(page, width, motion);
  for (const id of ['overview', 'routines']) {
    await page.goto(`${origin}/org/${id}`);
    await page.getByText('Not available yet', { exact: true }).waitFor();
    assert.equal(await page.locator('.register-row').count(), 0);
    assert.equal(await page.locator('oc-composer').count(), 0);
    if (id === 'overview') {
      await capture(page, id, width, motion);
    }
  }
  await page.goto(`${origin}/org/models`);
  await page.getByText('pinned-model', { exact: true }).waitFor();
  assert.equal(await page.locator('#monthly-ceiling').count(), 0);
  assert.equal(await page.getByText('retired-model', { exact: true }).count(), 0);
  await checkModelStatus(page);
  await capture(page, 'models', width, motion);
  await page.goto(`${origin}/org/spending`);
  await page.locator('#monthly-ceiling').waitFor();
  assert.equal(await page.getByRole('heading', { name: 'Spending', exact: true }).count(), 1);
  assert.equal(await page.getByText('pinned-model', { exact: true }).count(), 0);
  await capture(page, 'spending', width, motion);
  for (const [path, component] of [
    ['/org', 'oc-integration-register'], ['/org/integrations/', 'oc-integration-register'],
    ['/org/integrations/new', 'oc-mcp-install'],
    ['/org/integrations/odoo/tools', 'oc-tool-policy'], ['/org/history', 'oc-audit'],
    ['/history/chat', 'oc-audit'], ['/org/states', 'oc-state-specimen'],
  ]) {
    await page.goto(`${origin}${path}`);
    await page.locator(component).waitFor();
    assert.equal(await page.locator(component).count(), 1, 'Deep links keep their screen');
    if (component === 'oc-state-specimen') {
      assert.equal(await page.locator('[aria-current=page]').count(), 0);
    }
    if (component === 'oc-tool-policy') {
      await capture(page, 'integration-tools', width, motion);
    }
  }
  await page.goto(`${origin}/org/missing/`);
  await page.getByRole('heading', { name: 'Page not found', exact: true }).waitFor();
  assert.equal(await page.getByText('Not available yet', { exact: true }).count(), 0);
  assert.equal(await page.locator('[aria-current=page]').count(), 0);
}

await mkdir(output, { recursive: true });
const browser = await chromium.launch();
try {
  for (const width of [1280, 390]) {
    for (const motion of ['no-preference', 'reduce']) {
      const options = { viewport: { width, height: 900 }, reducedMotion: motion };
      const page = await browser.newPage(options);
      await page.route(`${origin}/**`, interceptAssets);
      await page.route('**/api/**', readFixture);
      await checkPages(page, width, motion);
      await page.close();
    }
  }
  const result = {
    result: 'PASS', widths: [1280, 390], motion: ['no-preference', 'reduce'], captures,
    environment: 'Built Angular assets; Chromium; disposable read fixtures; no stack',
    comparedFrames: ['INT-03', 'INT-37', 'OVR-01'],
    scope: 'Shell geometry and supported screen moves; unavailable design bodies are explicit',
  };
  await writeFile(`${output}/visual.json`, JSON.stringify(result, null, 2) + '\n');
  console.log(`PASS F3 shell: ${captures.length} captures; navigation, routes and screen moves`);
} finally {
  await browser.close();
}
