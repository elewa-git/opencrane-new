import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { chromium } from 'playwright';

const output = resolve('docs/process/f1-foundation');
const build = resolve('apps/web/dist/web/browser');
const origin = 'http://f1.opencrane.test';
const contentTypes = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.woff2': 'font/woff2', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
};

function integration(serverId, name, kind, label, detail) {
  return {
    serverId, name, source: { kind: 'remote_url', label: 'Remote server', detail: `${serverId}.example` },
    version: 'Version not provided', accountModel: 'Each person’s own',
    toolsAllowed: 0, toolsTotal: 2, status: { kind, label, detail },
  };
}

const register = {
  loadedAt: '2026-10-04T09:40:00.000Z',
  rows: [
    integration('odoo', 'Odoo Community', 'ready', 'Tool list checked',
      'Discovery checked 4 Oct 2026, 08:40 UTC; publication is a separate fact'),
    integration('microsoft', 'Microsoft 365', 'draft', 'Review not finished',
      'Nothing available to an assistant yet'),
    integration('slack', 'Slack', 'checking', 'Pending review', 'Image checks running'),
    integration('github', 'GitHub', 'needs_input', 'Needs a company connection', 'Company · not set up'),
  ],
};

async function interceptAssets(route) {
  const url = new URL(route.request().url());
  const asset = url.pathname;
  let filename = resolve(build, `.${asset}`);
  if (!filename.startsWith(`${build}/`)) {
    await route.abort();
    return;
  }
  if (!extname(asset)) filename = resolve(build, 'index.html');
  try {
    const body = await readFile(filename);
    const contentType = contentTypes[extname(filename)] ?? 'application/octet-stream';
    await route.fulfill({ body, contentType });
  } catch {
    await route.fulfill({ status: 404, body: 'Not found' });
  }
}

function closeSocket(socket) {
  socket.close();
}

async function fontsReady() {
  await globalThis.document.fonts.ready;
}

function hasNoOverflow() {
  return globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth;
}

function animationCount(node) {
  return node.getAnimations({ subtree: true }).length;
}

function pauseAnimations() {
  for (const animation of globalThis.document.getAnimations()) {
    animation.pause();
    animation.currentTime = 850;
  }
}

function retainsFocus(node) {
  return node === globalThis.document.activeElement;
}

function focusRing(node) {
  const style = globalThis.getComputedStyle(node);
  return [style.outlineWidth, style.outlineColor, style.outlineOffset];
}

function textureStyle(node) {
  const style = globalThis.getComputedStyle(node, '::before');
  return [style.opacity, style.backgroundSize, style.pointerEvents];
}

function cornerSize(node) {
  return globalThis.getComputedStyle(node, '::after').width;
}

function flatGrain(node) {
  return globalThis.getComputedStyle(node).backgroundImage;
}

function flutterOpacity(node) {
  return globalThis.getComputedStyle(node).opacity;
}

async function capture(page, name, width, motion) {
  assert(await page.evaluate(hasNoOverflow), `${name}: no horizontal overflow`);
  await page.evaluate(pauseAnimations);
  await page.screenshot({ path: `${output}/${name}-${width}-${motion}.png`, fullPage: true });
}

async function checkSpecimen(page, width, motion) {
  await page.goto(`${origin}/org/states`);
  await page.locator('.state-row').last().waitFor();
  await page.evaluate(fontsReady);
  assert.equal(await page.locator('.state-row').count(), 11);
  assert.equal(await page.locator('.state-row [aria-live]').count(), 0, 'Repeated rows are silent');
  assert.deepEqual(await page.locator('main').evaluate(textureStyle), ['0.42', '280px auto', 'none']);
  assert.equal(await page.locator('.paper-example').evaluate(cornerSize), '12px');
  for (const selector of ['oc-fold-loader', 'oc-flutter-loader', 'oc-grain-loader', '.spinner']) {
    const loader = page.locator(selector).first();
    const count = await loader.evaluate(animationCount);
    if (motion === 'reduce') assert.equal(count, 0, `${selector}: reduced motion is static`);
    else assert(count > 0, `${selector}: normal motion animates`);
  }
  if (motion === 'reduce') {
    assert.equal(await page.locator('oc-grain-loader').evaluate(flatGrain), 'none');
    assert.equal(await page.locator('oc-flutter-loader').evaluate(flutterOpacity), '0.6');
  }
  await capture(page, 'states', width, motion);
}

async function checkRegister(page, width, motion) {
  let releaseRead;
  function captureRelease(resolveRead) {
    releaseRead = resolveRead;
  }
  const pendingRead = new Promise(captureRelease);
  let reads = 0;
  async function integrations(route) {
    if (route.request().resourceType() !== 'fetch') {
      await route.fallback();
      return;
    }
    reads += 1;
    if (reads === 1) {
      await pendingRead;
      await route.fulfill({ json: register });
    } else {
      await route.fulfill({ status: 503, json: { status: 'unavailable' } });
    }
  }
  await page.route('**/api/org/integrations', integrations);
  await page.goto(`${origin}/org/integrations`);
  await page.locator('.skeleton-row').last().waitFor();
  await page.evaluate(fontsReady);
  assert.equal(await page.locator('.register').getAttribute('aria-busy'), 'true');
  assert.equal(await page.locator('.register [aria-live]').count(), 1);
  await capture(page, 'integrations-loading', width, motion);
  releaseRead();
  await page.locator('.register-row').last().waitFor();
  assert.equal(await page.locator('.register').getAttribute('aria-busy'), 'false');
  assert.equal(await page.locator('.register-row [aria-live]').count(), 0);
  const all = page.getByRole('tab', { name: 'All · 4', exact: true });
  await all.focus();
  await page.keyboard.press('ArrowRight');
  await page.locator('#integrations-tab-attention[aria-selected=true]').waitFor();
  await page.keyboard.press('Home');
  await page.locator('#integrations-tab-all[aria-selected=true]').waitFor();
  assert.deepEqual(await all.evaluate(focusRing), ['2px', 'rgb(10, 132, 151)', '2px']);
  if (width === 390) {
    const box = await all.boundingBox();
    assert(box.height >= 44, 'Phone tabs have 44px targets');
  }
  await capture(page, 'integrations-loaded', width, motion);
  const refresh = page.getByRole('button', { name: 'Refresh list', exact: true });
  await refresh.focus();
  await page.keyboard.press('Enter');
  await page.getByText('Showing what we loaded at', { exact: false }).waitFor();
  assert.equal(await page.locator('.register-row').count(), 4, 'Failed refresh keeps last read');
  assert(await refresh.evaluate(retainsFocus));
  assert.equal(await page.locator('.refresh-notice [aria-live]').count(), 0, 'No nested announcement');
  await capture(page, 'integrations-stale', width, motion);
  await page.unroute('**/api/org/integrations', integrations);
}

await mkdir(output, { recursive: true });
// Built assets are fulfilled in the browser. No daemon, port or live stack is required.
await readFile(resolve(build, 'index.html'));
const browser = await chromium.launch();
try {
  for (const width of [1280, 390]) {
    for (const motion of ['no-preference', 'reduce']) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: motion });
      await page.route(`${origin}/**`, interceptAssets);
      await page.routeWebSocket('**', closeSocket);
      await checkSpecimen(page, width, motion);
      await checkRegister(page, width, motion);
      await page.close();
    }
  }
  const result = {
    result: 'PASS', widths: [1280, 390], motion: ['no-preference', 'reduce'],
    captures: 16, environment: 'Built Angular assets; Chromium; intercepted read fixtures; no stack',
    checks: ['Eleven families', 'Silent repeated rows', 'Single progress region', '44px phone tabs',
      'Arrow keys and Home', '2px focus ring', 'Refresh retains focus and rows', 'No overflow',
      '12px dog-ear', '42% rice texture', 'Static reduced-motion loaders'],
  };
  await writeFile(`${output}/visual.json`, JSON.stringify(result, null, 2) + '\n');
  console.log('PASS F1 foundation: 16 captures, states, register, keyboard and reduced motion');
} finally {
  await browser.close();
}
