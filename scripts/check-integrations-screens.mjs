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
  'register-loading': 'The first register read is held to show its loading state.',
  'register-all': 'Tools use the honest Allow or Ask wording supplied by the API.',
  'register-attention': 'Rows keep the status labels sent by the server.',
  'register-stale': 'The refresh message sits above the rows so they remain usable.',
  'register-retrying': 'The first read failed. Skeleton rows stay visible while Refresh tries again.',
  'detail-draft': 'Unavailable connection and grant facts say Not available yet.',
  'detail-loading': 'The screen waits for the first register read before showing server facts.',
  'detail-retrying': 'The first read failed. The message-state Refresh button stays busy while it retries.',
  'detail-stale': 'The row and facts stay visible after the latest register read fails.',
  'detail-published': 'The page uses Manage tools and Check discovery status. Connection and grant sections are not available from the API. Available says Not available yet because grants cannot be read.',
  'access-lost': 'Back to workspace replaces the unfinished Overview page. The frame time is omitted because the API supplies no role-change time.',
  'detail-access-lost': 'Back to workspace replaces the unfinished Overview page. The frame time is omitted because the API supplies no role-change time.',
  'add-source': 'The source cards show the remote URL route because catalogue and hosted package admission are not available yet.',
  'add-checking': 'The discovery request is accepted and its result is still being checked.',
  'tools-blocked': 'Every reviewed tool starts on Block, so no tool can be called.',
  'tools-editing': 'The Allow choice is unsaved. The summary says that nobody can use tools before publication and grants.',
  'tools-conflict': 'Neutral wording replaces an actor and time because the API supplies neither.',
  'tools-unknown': 'The save reply was lost. The page offers a status read and does not resend the change.',
  'tools-check-still-unknown': 'The read has not found a later sequence. Reload tools is a separate GET.',
  'tools-check-matches': 'The saved policy matches the requested mode, but the page does not claim which command made it match.',
  'tools-failed': 'Reload tools replaces Try again because the same invalid input would fail again.',
  'tools-access-lost': 'The access-lost block clears the tools page and returns focus to its heading.',
};
const contentTypes = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.woff2': 'font/woff2', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
};

const integrations = {
  loadedAt: '2026-10-05T09:14:00.000Z',
  rows: [
    makeRow('orders', 'Orders server', 'ready', 'Published 5 Oct 2026, 09:14'),
    makeRow('legacy', 'Legacy server', 'disabled', 'Unpublished 5 Oct 2026, 09:14'),
    makeRow('pricing', 'Pricing server', 'needs_input', 'Pending review'),
    makeRow('metrics', 'Metrics server', 'checking', 'Validating server…', null),
    makeRow('broken', 'Broken server', 'failed', 'Validation failed; review before trying again'),
    makeRow('protected', 'Protected server', 'needs_input',
      'A scoped validation connection is required. Protected discovery is not available yet.'),
  ],
};

function makeRow(serverId, name, kind, detail, toolsTotal = 2) {
  const labels = {
    ready: 'Ready', disabled: 'Disabled', needs_input: 'Needs input',
    checking: 'Applying / checking', failed: 'Failed',
  };
  return {
    serverId, name, version: 'Version not provided',
    source: { kind: 'remote_url', label: 'Remote URL', detail: `${serverId}.example.test` },
    accountModel: 'Not provided', toolsAllowed: toolsTotal === null ? 0 : 1, toolsTotal,
    status: { kind, label: labels[kind], detail },
  };
}

function makePolicy(serverId, scenario) {
  const published = serverId === 'orders' && scenario === 'published';
  const toolScreen = scenario.startsWith('tools-');
  const initialReadMode = toolScreen ? 'block' : 'ask';
  return {
    connectionId: `${serverId}-connection`, accountMode: null, published, sequence: 3,
    tools: [
      { name: `${serverId}_read`, revision: 'rev-1', reviewed: true, readOnly: true,
        mode: initialReadMode, suggestion: 'allow' },
      { name: `${serverId}_change`, revision: 'rev-2', reviewed: toolScreen, readOnly: false,
        mode: 'block', suggestion: 'ask' },
    ],
  };
}

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
  let toolsPostCount = 0;
  const toolsRequestMethods = [];

  async function serveApi(route) {
    const request = route.request();
    const url = new URL(request.url());
    const pathname = url.pathname;
    if (pathname === '/api/org/integrations') {
      if (request.method() === 'POST' && scenario === 'add-checking') {
        await route.fulfill({ status: 202, json: { serverId: 'checking-id', changeRef: 'change-1' } });
        return;
      }
      registerReads += 1;
      if ((scenario === 'loading' || scenario === 'detail-loading') && registerReads === 1) {
        await state.loadingFinished;
        await route.fulfill({ json: integrations });
        return;
      }
      if (scenario === 'register-retrying' && registerReads === 1) {
        await route.fulfill({ status: 503, json: { status: 'unavailable' } });
        return;
      }
      if ((scenario === 'register-retrying' && registerReads === 2)
        || (scenario === 'detail-retrying' && registerReads === 2)) {
        await state.loadingFinished;
        await route.fulfill({ json: integrations });
        return;
      }
      if (scenario === 'detail-stale' && registerReads === 2) {
        await route.fulfill({ status: 503, json: { status: 'unavailable' } });
        return;
      }
      if (scenario === 'stale' && registerReads === 2) {
        await route.fulfill({ status: 503, json: { status: 'unavailable' } });
        return;
      }
      if (scenario === 'register-failed' && registerReads === 1) {
        await route.fulfill({ status: 503, json: { status: 'unavailable' } });
        return;
      }
      if (scenario.startsWith('detail-') && scenario !== 'detail-tools-failed'
        && scenario !== 'detail-not-found' && scenario !== 'detail-stale'
        && registerReads === 1) {
        const status = scenario === 'detail-access-lost' ? 403 : 503;
        await route.fulfill({ status, body: '' });
        return;
      }
      if (scenario === 'detail-not-found' && registerReads === 1) {
        await route.fulfill({ json: { rows: [], loadedAt: integrations.loadedAt } });
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
    if (pathname.endsWith('/discovery')) {
      await route.fulfill({ status: 503, json: { status: 'unavailable' } });
      return;
    }
    if (pathname.endsWith('/tools')) {
      toolsRequestMethods.push(request.method());
      if (request.method() === 'POST') toolsPostCount += 1;
      if (scenario === 'tools-conflict' && request.method() === 'POST') {
        await route.fulfill({ status: 409, json: { status: 'conflict' } });
        return;
      }
      if ((scenario === 'tools-unknown' || scenario.startsWith('tools-check-'))
        && request.method() === 'POST') {
        await route.fulfill({ status: 503, json: { status: 'unavailable' } });
        return;
      }
      if (scenario === 'tools-failed' && request.method() === 'POST') {
        await route.fulfill({ status: 400, json: { status: 'invalid_request' } });
        return;
      }
      if (scenario === 'tools-access-lost' && request.method() === 'POST') {
        await route.fulfill({ status: 403, body: '' });
        return;
      }
      if (scenario === 'detail-tools-failed' || scenario === 'detail-stale') {
        await route.fulfill({ status: 503, json: { status: 'unavailable' } });
        return;
      }
      const serverId = pathname.split('/')[4];
      const policy = makePolicy(serverId, scenario);
      if (scenario === 'tools-check-matches' && request.method() === 'GET'
        && toolsPostCount > 0) {
        policy.sequence = 4;
        policy.tools[0].mode = 'allow';
      }
      await route.fulfill({ json: policy });
      return;
    }
    await route.fulfill({ status: 404, json: { status: 'missing' } });
  }
  return {
    serveApi,
    state,
    toolsPostCount: () => toolsPostCount,
    requestMethods: () => toolsRequestMethods,
  };
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

function readComputedColour(node) {
  return globalThis.getComputedStyle(node).color;
}

function readTokenColour(root) {
  const probe = root.ownerDocument.createElement('span');
  probe.style.color = 'var(--oc-ink-strong)';
  root.append(probe);
  const colour = globalThis.getComputedStyle(probe).color;
  probe.remove();
  return colour;
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
  const controls = page.locator('main button, main a, main .source-card, main .modes label');
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
    if (scenario === 'register-failed') await checkFailedFirstRead(page);
    if (scenario === 'all') await checkNotReadYetRow(page);
    if (prepare) await prepare(page, opened.fixtures.state);
    await waitForFonts(page);
    await capture(page, name, width, motion);
    if (scenario === 'register-retrying') opened.fixtures.state.finishLoading();
  } finally {
    await opened.context.close();
  }
}

async function checkFailedFirstRead(page) {
  assert.equal(await page.getByText("Couldn't load the integrations list.", {
    exact: true,
  }).count(), 1, 'A failed first read shows one failure message on the page');
  const tabText = await page.locator('.tabs').innerText();
  assert.equal(tabText.includes('· 0'), false, 'Failed reads do not show zero tab counts');
  assert.equal(await page.locator('.register').getAttribute('tabindex'), null,
    'An empty failed panel is not a keyboard stop');
}

async function checkNotReadYetRow(page) {
  const metricsRow = page.locator('.register-row').filter({ hasText: 'Metrics server' });
  const toolsCell = metricsRow.locator('.tools');
  const toolsText = await toolsCell.innerText();
  assert.match(toolsText, /Not read yet/u, 'The checking row has not read its tool count');
}

async function waitForRegisterState(page, scenario) {
  if (scenario === 'empty') {
    const emptyMessage = page.getByText('No integrations yet', { exact: true });
    await emptyMessage.waitFor();
    assert(await emptyMessage.isVisible());
    return;
  }
  if (scenario === 'register-failed') {
    await page.getByText("Couldn't load the integrations list.", { exact: true }).waitFor();
    return;
  }
  if (scenario === 'register-retrying') {
    await page.getByText("Couldn't load the integrations list.", { exact: true }).waitFor();
    return;
  }
  await page.locator('.register-row').first().waitFor();
}

async function checkAccessLinkColour(page) {
  const backLink = page.getByRole('link', { name: 'Back to workspace', exact: true });
  const linkColour = await backLink.evaluate(readComputedColour);
  const expectedColour = await page.locator('html').evaluate(readTokenColour);
  assert.equal(linkColour, expectedColour, 'The access link uses the dark text colour');
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
  assert.equal(await page.locator('.register-row').count(), 6);
}

async function prepareRegisterRetrying(page) {
  await page.getByRole('button', { name: 'Refresh list' }).click();
  await page.locator('.refresh-notice').waitFor();
  const noticeText = await page.locator('.refresh-notice').innerText();
  assert.match(noticeText, /Waiting for the list to load/u);
}

async function prepareNoMatch(page) {
  const search = page.getByRole('searchbox', { name: 'Search integrations' });
  await search.fill('no-such-integration');
  await page.getByText('No integrations match “no-such-integration”.').waitFor();
}

async function checkRegisterColumns(page) {
  const positions = await page.evaluate(() => {
    const headings = [...globalThis.document.querySelectorAll('.register-header span')];
    const rows = [...globalThis.document.querySelectorAll('.register-row')];
    return rows.map((row) => ({
      headings: headings.map((cell) => Math.round(cell.getBoundingClientRect().x)),
      cells: ['.server', '.account', '.tools', '.status'].map((selector) =>
        Math.round(row.querySelector(selector).getBoundingClientRect().x)),
    }));
  });
  for (const row of positions) {
    assert.deepEqual(row.cells, row.headings.slice(0, 4), 'Columns line up with their headings');
  }
}

async function checkWholeRowLink(page) {
  const clickedRow = page.locator('.register-row').first();
  const statusCell = clickedRow.locator('.status');
  const link = clickedRow.locator('a.row-link');
  const statusBox = await statusCell.boundingBox();
  assert(statusBox, 'The first row has a visible Status cell');
  const statusPoint = {
    x: statusBox.x + statusBox.width / 2,
    y: statusBox.y + statusBox.height / 2,
  };
  const isRowLink = await page.evaluate((point) => {
    const row = globalThis.document.querySelector('.register-row');
    const element = globalThis.document.elementFromPoint(point.x, point.y);
    return element?.closest('a.row-link') === row?.querySelector('a.row-link');
  }, statusPoint);
  assert(isRowLink, 'Clicking a row Status cell lands on that row link');
  assert.equal(await link.count(), 1);
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
    if (scenario === 'detail-loading') {
      await page.locator('section.loading').waitFor();
      await page.locator('section.loading').getByText('Loading integration…', {
        exact: true,
      }).waitFor();
      await waitForFonts(page);
      await capture(page, name, width, motion);
      opened.fixtures.state.finishLoading();
      return;
    }
    if (scenario === 'detail-retrying') {
      await page.locator('.message-state').getByText("Couldn't load this integration.", {
        exact: true,
      }).waitFor();
      await page.getByRole('button', { name: 'Refresh' }).click();
      await page.getByRole('button', { name: 'Refreshing…' }).waitFor();
      await page.getByText('Refreshing integration…', { exact: true }).waitFor();
    } else if (scenario === 'detail-stale') {
      await page.locator('.fact').nth(3).waitFor();
      await page.getByRole('button', { name: 'Refresh' }).click();
      await page.locator('.detail-failure').getByText("Couldn't load this integration.", {
        exact: true,
      }).waitFor();
    } else if (scenario === 'detail-not-found') {
      await page.getByRole('heading', { name: 'Integration not found' }).waitFor();
    } else if (scenario === 'detail-failed') {
      await page.locator('.message-state .message').waitFor();
    } else if (scenario === 'detail-access-lost') {
      await page.getByRole('heading', { name: 'You no longer have access to Integrations' }).waitFor();
      await checkAccessLinkColour(page);
    } else if (scenario === 'detail-tools-failed') {
      await page.locator('.fact').nth(3).getByText("Couldn't check", { exact: true }).waitFor();
    } else {
      await page.locator('.fact').nth(3).waitFor();
    }
    const messageState = scenario === 'detail-not-found' || scenario === 'detail-failed'
      || scenario === 'detail-tools-failed' || scenario === 'detail-access-lost'
      || scenario === 'detail-retrying';
    if (messageState) {
      await waitForFonts(page);
      await capture(page, name, width, motion);
      return;
    }
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

async function captureAdd(browser, name, width, motion, scenario) {
  const opened = await openPage(browser, width, motion, scenario);
  const { page } = opened;
  try {
    await page.goto(`${origin}/org/integrations/new`);
    if (scenario === 'add-checking') {
      await page.getByLabel('Server URL').fill('https://remote.example.test/mcp');
      await page.getByRole('button', { name: 'Discover tools' }).click();
      await page.getByText('Validating the server and discovering tools…').waitFor();
      await page.locator('.status-region').waitFor();
    } else {
      await page.getByRole('heading', { name: 'Add an integration' }).waitFor();
      await checkSourceCardHitTarget(page);
    }
    await waitForFonts(page);
    await capture(page, name, width, motion);
  } finally {
    await opened.context.close();
  }
}

async function checkSourceCardHitTarget(page) {
  const card = page.locator('.source-card.selected');
  const box = await card.boundingBox();
  assert(box, 'The selected source card has a visible hit area');
  const point = { x: box.x + box.width - 12, y: box.y + box.height - 12 };
  const cardOwnsPoint = await page.evaluate(sourceCardOwnsPoint, point);
  assert(cardOwnsPoint, 'The whole selected source card is clickable');
  await page.mouse.click(point.x, point.y);
  assert(await page.locator('input[name="source"]:checked').count() === 1,
    'Clicking the source card keeps the remote radio selected');
}

async function captureTools(browser, name, width, motion, scenario) {
  const opened = await openPage(browser, width, motion, scenario);
  const { page } = opened;
  try {
    await page.goto(`${origin}/org/integrations/orders/tools`);
    if (scenario === 'tools-access-lost') {
      await page.locator('fieldset').first().waitFor();
      await page.locator('input[name="mode-orders_read"][value="allow"]').click();
      await page.getByRole('button', { name: 'Save mode for orders_read' }).click();
      const heading = page.getByRole('heading', {
        name: 'You no longer have access to Integrations', exact: true,
      });
      await heading.waitFor();
      assert(await heading.evaluate(focused), 'The access-lost heading receives focus');
      await checkAccessLinkColour(page);
    } else {
      await page.locator('fieldset').first().waitFor();
      const firstRadio = page.locator('input[name="mode-orders_read"]').first();
      await firstRadio.focus();
      assert.deepEqual(await firstRadio.evaluate(focusRing),
        ['2px', 'rgb(10, 132, 151)', '3px']);
      await page.keyboard.press('ArrowRight');
      assert(await page.locator('input[name="mode-orders_read"][value="ask"]').isChecked(),
        'ArrowRight moves to the next native mode radio');
      await firstRadio.focus();
      await page.keyboard.press('ArrowDown');
      assert(await page.locator('input[name="mode-orders_read"][value="ask"]').isChecked(),
        'ArrowDown moves to the next native mode radio');
      await page.locator('input[name="mode-orders_read"][value="block"]').click();
      if (scenario === 'tools-editing') {
        await page.locator('input[name="mode-orders_read"][value="allow"]').click();
        await page.getByText(/1 Allow automatically · 0 Ask · 1 Block/u).waitFor();
      }
      const needsSave = scenario === 'tools-conflict' || scenario === 'tools-failed'
        || scenario === 'tools-unknown' || scenario.startsWith('tools-check-');
      if (needsSave) {
        await page.locator('input[name="mode-orders_read"][value="allow"]').click();
        await page.getByRole('button', { name: 'Save mode for orders_read' }).click();
      }
      if (scenario === 'tools-conflict') {
        await page.getByText('The tools changed before your save').waitFor();
        assert.equal(await page.getByRole('button', { name: 'Review the current modes' }).count(), 1);
        assert.equal(await page.getByRole('button', { name: 'Discard my edits' }).count(), 1);
      }
      if (scenario === 'tools-failed') {
        await page.getByText('Failed — nothing changed').waitFor();
        assert.equal(await page.getByText('Try again', { exact: true }).count(), 0);
      }
      if (scenario === 'tools-unknown') {
        await page.getByText('Outcome unknown').waitFor();
        assert.equal(await page.getByRole('button', { name: 'Check status' }).count(), 1);
        assert(await page.locator('fieldset').evaluateAll(allDisabled));
      }
      if (scenario === 'tools-check-still-unknown') {
        await page.getByText('Outcome unknown').waitFor();
        await page.getByRole('button', { name: 'Check status' }).click();
        await page.getByText('Still unknown').waitFor();
        await capture(page, name, width, motion);
        await page.getByRole('button', { name: 'Check status' }).click();
        await page.getByText('Still unknown').waitFor();
        await page.getByRole('button', { name: 'Reload tools' }).click();
        await page.locator('fieldset').first().waitFor();
        await page.waitForFunction(noStateActionButtons);
        assert.equal(opened.fixtures.toolsPostCount(), 1,
          'One POST is sent across unknown, both checks and reload');
        const laterMethods = opened.fixtures.requestMethods().slice(2);
        assert(laterMethods.every(isReadMethod), 'Every request after save is a GET');
        return;
      }
      if (scenario === 'tools-check-matches') {
        await page.getByText('Outcome unknown').waitFor();
        await page.getByRole('button', { name: 'Check status' }).click();
        await page.getByText('Saved policy matches your change').waitFor();
      }
    }
    await waitForFonts(page);
    await capture(page, name, width, motion);
  } finally {
    await opened.context.close();
  }
}

function allDisabled(fieldsets) {
  return fieldsets.every((fieldset) => fieldset.disabled);
}

function isReadMethod(method) {
  return method === 'GET' || method === undefined;
}

function sourceCardOwnsPoint(position) {
  const element = globalThis.document.elementFromPoint(position.x, position.y);
  const card = globalThis.document.querySelector('.source-card.selected');
  return element?.closest('label.source-card') === card;
}

function noStateActionButtons() {
  return globalThis.document.querySelectorAll('.state-action').length === 0;
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
      if (width === 1280) {
        const aligned = await openPage(browser, width, motion, 'all');
        try {
          await aligned.page.goto(`${origin}/org/integrations`);
          await aligned.page.locator('.register-row').first().waitFor();
          await checkRegisterColumns(aligned.page);
          await checkWholeRowLink(aligned.page);
        } finally {
          await aligned.context.close();
        }
      }
      await captureRegister(browser, 'register-attention', width, motion, 'all', prepareAttention);
      await captureRegister(browser, 'register-review', width, motion, 'all', prepareReview);
      await captureRegister(browser, 'register-stale', width, motion, 'stale', prepareStale);
      await captureRegister(browser, 'register-failed', width, motion, 'register-failed');
      await captureRegister(browser, 'register-retrying', width, motion, 'register-retrying',
        prepareRegisterRetrying);
      await captureRegister(browser, 'register-no-match', width, motion, 'all', prepareNoMatch);
      await captureRegister(browser, 'access-lost', width, motion, 'access-lost', prepareAccessLost);
      await captureDetail(browser, 'detail-draft', width, motion, 'draft', 'pricing');
      await captureDetail(browser, 'detail-loading', width, motion, 'detail-loading', 'orders');
      await captureDetail(browser, 'detail-retrying', width, motion,
        'detail-retrying', 'orders');
      await captureDetail(browser, 'detail-stale', width, motion, 'detail-stale', 'orders');
      await captureDetail(browser, 'detail-published', width, motion, 'published', 'orders');
      await captureDetail(browser, 'detail-not-found', width, motion, 'detail-not-found', 'missing');
      await captureDetail(browser, 'detail-failed', width, motion, 'detail-failed', 'orders');
      await captureDetail(browser, 'detail-tools-failed', width, motion,
        'detail-tools-failed', 'orders');
      await captureDetail(browser, 'detail-access-lost', width, motion,
        'detail-access-lost', 'orders');
      await captureAdd(browser, 'add-source', width, motion, 'add-source');
      await captureAdd(browser, 'add-checking', width, motion, 'add-checking');
      await captureTools(browser, 'tools-blocked', width, motion, 'tools-blocked');
      await captureTools(browser, 'tools-editing', width, motion, 'tools-editing');
      await captureTools(browser, 'tools-conflict', width, motion, 'tools-conflict');
      await captureTools(browser, 'tools-unknown', width, motion, 'tools-unknown');
      await captureTools(browser, 'tools-check-still-unknown', width, motion,
        'tools-check-still-unknown');
      await captureTools(browser, 'tools-check-matches', width, motion, 'tools-check-matches');
      await captureTools(browser, 'tools-failed', width, motion, 'tools-failed');
      await captureTools(browser, 'tools-access-lost', width, motion, 'tools-access-lost');
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
      'INT-10', 'INT-30', 'INT-31', 'INT-37', 'INT-93', 'INT-94', 'INT-95', 'INT-96',
    ],
    scope: 'Register, detail, add and tool modes supported by the current integrations API.',
  };
  await writeFile(`${output}/visual.json`, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`PASS integrations screens: ${captures.length} captures`);
} finally {
  await browser.close();
}
