import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { chromium } from 'playwright';

const output = resolve('docs/process/integrations-screens');
const build = resolve('apps/web/dist/web/browser');
const origin = 'https://integrations.opencrane.test';
const widths = [1280, 390, 320];
const motionOptions = ['no-preference', 'reduce'];
const captures = [];
const adaptations = {
  'register-empty': 'No catalogue or package rows exist in the current API.',
  'register-all': 'Tools use the honest Allow or Ask wording supplied by the API.',
  'detail-draft': 'Unavailable connection and grant facts say Not available yet.',
  'access-lost': 'Back to workspace replaces the unavailable Overview destination.',
};
const contentTypes = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.woff2': 'font/woff2', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
};

const integrations = {
  loadedAt: '2026-10-05T09:14:00.000Z',
  rows: [
    makeRow('orders', 'Orders server', 'ready', 'Published'),
    makeRow('pricing', 'Pricing server', 'needs_input', 'Pending review'),
    makeRow('metrics', 'Metrics server', 'checking', 'Validating server…'),
    makeRow('broken', 'Broken server', 'failed', 'Validation failed; review before trying again'),
    makeRow('protected', 'Protected server', 'needs_input',
      'A scoped validation connection is required. Protected discovery is not available yet.'),
  ],
};

function makeRow(serverId, name, kind, detail) {
  const labels = {
    ready: 'Ready', needs_input: 'Needs input', checking: 'Applying / checking', failed: 'Failed',
  };
  return {
    serverId, name, version: 'Version not provided',
    source: { kind: 'remote_url', label: 'Remote URL', detail: `${serverId}.example.test` },
    accountModel: 'Not provided', toolsAllowed: 1, toolsTotal: 2,
    status: { kind, label: labels[kind], detail },
  };
}

const policy = {
  connectionId: null, accountMode: null, published: false, sequence: 3,
  tools: [
    { name: 'read_order', revision: 'rev-1', reviewed: true, readOnly: true,
      mode: 'ask', suggestion: 'allow' },
    { name: 'change_order', revision: 'rev-2', reviewed: false, readOnly: false,
      mode: 'block', suggestion: 'ask' },
  ],
};

async function serveAssets(route) {
  const url = new URL(route.request().url());
  let filename = resolve(build, `.${url.pathname}`);
  if (!extname(url.pathname)) filename = resolve(build, 'index.html');
  if (!filename.startsWith(`${build}/`)) {
    await route.abort();
    return;
  }
  const body = await readFile(filename);
  const contentType = contentTypes[extname(filename)] ?? 'application/octet-stream';
  await route.fulfill({ body, contentType });
}

function makeFixtures(scenario) {
  let registerReads = 0;
  let finishLoading;
  const loadingFinished = new Promise((resolveLoading) => {
    finishLoading = resolveLoading;
  });
  const state = { loadingFinished, finishLoading };

  async function serveApi(route) {
    const request = route.request();
    const url = new URL(request.url());
    const pathname = url.pathname;
    if (pathname === '/api/org/integrations') {
      registerReads += 1;
      if (scenario === 'loading' && registerReads === 1) {
        await state.loadingFinished;
        await route.fulfill({ json: integrations });
        return;
      }
      if (scenario === 'stale' && registerReads === 2) {
        await route.fulfill({ status: 503, json: { status: 'unavailable' } });
        return;
      }
      if (scenario === 'access-lost' && registerReads === 2) {
        await route.fulfill({ status: 403, body: '' });
        return;
      }
      const fixture = scenario === 'empty' ? { rows: [], loadedAt: integrations.loadedAt } : integrations;
      await route.fulfill({ json: fixture });
      return;
    }
    if (pathname.endsWith('/tools')) {
      const toolsPolicy = { ...policy, published: scenario === 'published' };
      await route.fulfill({ json: toolsPolicy });
      return;
    }
    await route.fulfill({ status: 404, json: { status: 'missing' } });
  }
  return { serveApi, state };
}

async function serveIdentity(route) {
  await route.fulfill({ json: {
    authenticated: true,
    user: { email: 'jente@elewa.ke', role: 'Owner' },
  } });
}

function pageFitsViewport() {
  return globalThis.document.documentElement.scrollWidth <= globalThis.window.innerWidth;
}

function focused(node) {
  return node === globalThis.document.activeElement;
}

function focusRing(node) {
  const style = globalThis.getComputedStyle(node);
  return [style.outlineWidth, style.outlineColor, style.outlineOffset];
}

function grainAnimation(node) {
  return globalThis.getComputedStyle(node).animationName;
}

async function waitForFonts(page) {
  await page.evaluate(() => globalThis.document.fonts.ready);
}

async function checkMobileTargets(page, width) {
  if (width > 390) return;
  const controls = page.locator('main button, main a');
  const count = await controls.count();
  for (let index = 0; index < count; index += 1) {
    const item = controls.nth(index);
    if (!(await item.isVisible())) continue;
    const box = await item.boundingBox();
    assert(box && box.height >= 44, 'Every visible phone link and button is at least 44px high');
  }
}

async function capture(page, name, width, motion) {
  assert(await page.evaluate(pageFitsViewport), 'The page has no horizontal overflow');
  await checkMobileTargets(page, width);
  const filename = `${name}-${width}-${motion}.png`;
  await page.screenshot({ path: `${output}/${filename}`, fullPage: true });
  captures.push({ name: filename, adaptations: adaptations[name] ?? 'Current API data shown as supplied.' });
}

async function openPage(browser, width, motion, scenario) {
  const context = await browser.newContext({
    viewport: { width, height: 900 }, reducedMotion: motion,
  });
  const page = await context.newPage();
  const fixtures = makeFixtures(scenario);
  await page.route(`${origin}/**`, serveAssets);
  await page.route('**/auth/me', serveIdentity);
  await page.route('**/api/**', fixtures.serveApi);
  return { context, page, fixtures };
}

async function captureRegister(browser, name, width, motion, scenario, prepare) {
  const opened = await openPage(browser, width, motion, scenario);
  const { page } = opened;
  try {
    await page.goto(`${origin}/org/integrations`);
    await waitForRegisterState(page, scenario);
    if (prepare) await prepare(page, opened.fixtures.state);
    await waitForFonts(page);
    await capture(page, name, width, motion);
  } finally {
    await opened.context.close();
  }
}

async function waitForRegisterState(page, scenario) {
  if (scenario === 'empty') {
    const emptyMessage = page.getByText('No integrations yet', { exact: true });
    await emptyMessage.waitFor();
    assert(await emptyMessage.isVisible());
    return;
  }
  await page.locator('.register-row').first().waitFor();
}

async function prepareAttention(page) {
  await page.locator('.register-row').first().waitFor();
  await page.getByRole('tab', { name: /Needs attention/ }).click();
}

async function prepareReview(page) {
  await page.locator('.register-row').first().waitFor();
  await page.getByRole('tab', { name: /Pending review/ }).click();
}

async function prepareStale(page) {
  await page.locator('.register-row').first().waitFor();
  await page.getByRole('button', { name: 'Refresh list' }).click();
  await page.getByText('Showing what we loaded at 09:14 UTC').waitFor();
  assert.equal(await page.locator('.register-row').count(), 5);
}

async function prepareAccessLost(page) {
  await page.locator('.register-row').first().waitFor();
  await page.getByRole('button', { name: 'Refresh list' }).click();
  const heading = page.getByRole('heading', {
    name: 'You no longer have access to Integrations', exact: true,
  });
  await heading.waitFor();
  assert(await heading.evaluate(focused));
  assert.equal(await page.locator('.register-row').count(), 0);
  assert.equal(await page.getByRole('link', { name: 'Add an integration' }).count(), 0);
}

async function checkRegisterInteraction(browser, width, motion) {
  const opened = await openPage(browser, width, motion, 'all');
  const { page } = opened;
  try {
    await page.goto(`${origin}/org/integrations`);
    await page.locator('.register-row').first().waitFor();
    const tabs = page.getByRole('tab');
    await tabs.first().focus();
    await page.keyboard.press('ArrowRight');
    assert(await tabs.nth(1).evaluate(focused));
    const search = page.getByRole('searchbox', { name: 'Search integrations' });
    await search.focus();
    assert.deepEqual(await search.evaluate(focusRing), ['2px', 'rgb(10, 132, 151)', '2px']);
    const reviewTab = page.getByRole('tab', { name: /Pending review/ });
    await reviewTab.focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Tab');
    assert(await search.evaluate(focused));
    const rowLink = page.getByRole('link', { name: /^Pricing server\b/u });
    const rowAction = page.getByRole('link', { name: 'Continue review for Pricing server' });
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    assert(await rowLink.evaluate(focused));
    assert.deepEqual(await rowLink.evaluate(focusRing), ['2px', 'rgb(10, 132, 151)', '2px']);
    await page.keyboard.press('Tab');
    assert(await rowAction.evaluate(focused));
    assert.deepEqual(await rowAction.evaluate(focusRing),
      ['2px', 'rgb(10, 132, 151)', '2px']);
  } finally {
    await opened.context.close();
  }
}

async function captureMenu(browser, width, motion) {
  const opened = await openPage(browser, width, motion, 'all');
  const { page } = opened;
  try {
    await page.goto(`${origin}/org/integrations`);
    const opener = page.getByRole('button', { name: 'Open organisation navigation' });
    await opener.focus();
    await page.keyboard.press('Enter');
    const menu = page.getByRole('dialog', { name: 'Organisation settings' });
    await menu.waitFor();
    assert(await menu.locator('h2').evaluate(focused));
    await capture(page, 'menu', width, motion);
    await page.keyboard.press('Escape');
    assert(await opener.evaluate(focused));
  } finally {
    await opened.context.close();
  }
}

async function captureDetail(browser, name, width, motion, scenario, serverId) {
  const opened = await openPage(browser, width, motion, scenario);
  const { page } = opened;
  try {
    await page.goto(`${origin}/org/integrations/${serverId}`);
    await page.locator('.fact').nth(3).waitFor();
    const labels = await page.locator('.fact h3').allTextContents();
    assert.deepEqual(labels.map((label) => label.trim()), [
      'Installed', 'Connected', 'Allowed for', 'Available to the assistant',
    ]);
    assert.match(await page.locator('.fact').nth(1).textContent(), /Not available yet/u);
    assert.match(await page.locator('.fact').nth(2).textContent(), /Not available yet/u);
    await capture(page, name, width, motion);
  } finally {
    await opened.context.close();
  }
}

await mkdir(output, { recursive: true });
const browser = await chromium.launch();
try {
  for (const width of widths) {
    for (const motion of motionOptions) {
      await captureRegister(browser, 'register-empty', width, motion, 'empty');
      const loading = await openPage(browser, width, motion, 'loading');
      try {
        await loading.page.goto(`${origin}/org/integrations`);
        await loading.page.locator('.register[aria-busy="true"]').waitFor();
        assert.equal(await loading.page.locator('oc-grain-loader').first()
          .evaluate(grainAnimation), motion === 'reduce' ? 'none' : 'oc-grain');
        await capture(loading.page, 'register-loading', width, motion);
        loading.fixtures.state.finishLoading();
      } finally {
        loading.fixtures.state.finishLoading();
        await loading.context.close();
      }
      await captureRegister(browser, 'register-all', width, motion, 'all');
      await captureRegister(browser, 'register-attention', width, motion, 'all', prepareAttention);
      await captureRegister(browser, 'register-review', width, motion, 'all', prepareReview);
      await captureRegister(browser, 'register-stale', width, motion, 'stale', prepareStale);
      await captureRegister(browser, 'access-lost', width, motion, 'access-lost', prepareAccessLost);
      await captureDetail(browser, 'detail-draft', width, motion, 'draft', 'pricing');
      await captureDetail(browser, 'detail-published', width, motion, 'published', 'orders');
      await checkRegisterInteraction(browser, width, motion);
    }
    if (width <= 390) {
      for (const motion of motionOptions) await captureMenu(browser, width, motion);
    }
  }
  const result = {
    result: 'PASS', widths, motion: motionOptions, captures,
    environment: 'Built Angular assets; Chromium; disposable API fixtures; no stack',
    comparedFrames: [
      'INT-01', 'INT-02', 'INT-03', 'INT-04', 'INT-05', 'INT-06', 'INT-07', 'INT-08',
      'INT-37', 'INT-94',
    ],
    scope: 'Register and detail screens supported by the current integrations API.',
  };
  await writeFile(`${output}/visual.json`, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`PASS integrations screens: ${captures.length} captures`);
} finally {
  await browser.close();
}
