import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { chromium } from 'playwright';
import { chatFixture } from './chat-fixture.mjs';

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
      'Discovery checked 4 Oct, 08:40 UTC'),
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

function foldClip(node) {
  return globalThis.getComputedStyle(node).clipPath;
}

function focusVisible(node) {
  return node.matches(':focus-visible');
}

function outlineStyle(node) {
  return globalThis.getComputedStyle(node).outlineStyle;
}

function clearSelection() {
  const selection = globalThis.getSelection();
  selection?.removeAllRanges();
}

async function checkFold(paper, size) {
  assert.equal(await paper.evaluate(cornerSize), `${size}px`);
  const clip = await paper.evaluate(foldClip);
  assert(clip.startsWith('polygon('), 'The paper clips its folded corner');
  assert(clip.includes(`calc(100% - ${size}px)`), 'The clip follows the fold size');
}

async function checkKeyboardRing(button) {
  assert.equal(await button.evaluate(focusVisible), true, 'Keyboard focus is visible');
  const ring = await button.evaluate(focusRing);
  assert.equal(ring[0], '2px');
  assert(['rgb(13, 181, 204)', 'rgb(10, 132, 151)'].includes(ring[1]));
  assert.equal(ring[2], '2px');
  assert.equal(await button.evaluate(foldClip), 'none', 'The focus ring is outside the clip');
}

async function checkPointerRing(page, button) {
  await button.hover();
  await page.mouse.down();
  assert.equal(await button.evaluate(retainsFocus), true, 'Pointer press focuses the button');
  assert.equal(await button.evaluate(focusVisible), false, 'Pointer focus is not keyboard focus');
  const style = await button.evaluate(outlineStyle);
  assert.equal(style, 'none', 'Pointer focus does not draw a keyboard ring');
  // Release outside the button so this focus check does not open its preview.
  await page.mouse.move(0, 0);
  await page.mouse.up();
  await page.evaluate(clearSelection);
}

function flatGrain(node) {
  return globalThis.getComputedStyle(node).backgroundImage;
}

function textColour(node) {
  return globalThis.getComputedStyle(node).color;
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
  assert.equal(await page.locator('[data-state=checking]').evaluate(textColour),
    'rgb(10, 111, 126)');
  assert.equal(await page.locator('.interaction').first().evaluate(textColour),
    'rgb(10, 111, 126)');
  assert.equal(await page.locator('.state-row [aria-live]').count(), 0, 'Repeated rows are silent');
  assert.deepEqual(await page.locator('main').evaluate(textureStyle), ['0.42', '280px auto', 'none']);
  const specimenPaper = page.locator('.paper-example');
  await checkFold(specimenPaper, 12);
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
  const status = await page.locator('main [role=status]').elementHandle();
  assert.equal(await page.locator('main [role=status]').innerText(), 'Loading integrations…');
  assert.equal(await page.locator('.register').getAttribute('aria-busy'), 'true');
  assert.equal(await page.locator('main [role=status]').count(), 1);
  assert.equal(await page.locator('[aria-busy=true] [aria-live]').count(), 0);
  await capture(page, 'integrations-loading', width, motion);
  releaseRead();
  await page.locator('.register-row').last().waitFor();
  assert.equal(await page.locator('.register').getAttribute('aria-busy'), 'false');
  assert.equal(await status.evaluate(nodeConnected), true, 'Loading status persists');
  assert.equal(await page.locator('main [role=status]').innerText(), 'Integrations loaded');
  assert.equal(await page.locator('.register-row [aria-live]').count(), 0);
  const addServer = page.getByRole('link', { name: 'Add MCP server', exact: true });
  assert.equal(await addServer.evaluate(textColour), 'rgb(22, 25, 26)');
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
  const rowHeight = await page.locator('.register-row').first().boundingBox();
  if (width === 1280) assert(rowHeight.height <= 90, 'Status rows stay near 80px');
  await capture(page, 'integrations-loaded', width, motion);
  const refresh = page.getByRole('button', { name: 'Refresh list', exact: true });
  await refresh.focus();
  await page.keyboard.press('Enter');
  await page.getByText('Showing what we loaded at', { exact: false }).waitFor();
  assert.equal(await page.locator('.register-row').count(), 4, 'Failed refresh keeps last read');
  assert.equal(await page.locator('.register').getAttribute('class'), 'register stale');
  const noticeBox = await page.locator('.refresh-notice').boundingBox();
  const tabsBox = await page.locator('.tabs').boundingBox();
  assert(noticeBox.y < tabsBox.y, 'Stale notice is above the tabs');
  const noticeText = await page.locator('.refresh-notice').innerText();
  assert(noticeText.includes('09:40 UTC'));
  assert.equal(await page.locator('.refresh-notice button').count(), 1);
  assert.equal(await page.locator('.notice-glyph').count(), 1, 'Stale warning has a glyph');
  const appearance = await page.locator('.register-row').first().evaluate(staleAppearance);
  assert.notEqual(appearance.tileBackground, appearance.rowBackground, 'Tile stands out');
  assert.equal(appearance.tileOpacity, '0.6');
  assert.equal(appearance.glyphOpacity, '0.6');
  assert.deepEqual(await page.locator('.notice-copy strong').evaluate(noticeTypography),
    ['13px', '500']);
  assert(await refresh.evaluate(retainsFocus));
  assert.equal(await page.locator('.refresh-notice [aria-live]').count(), 0, 'No nested announcement');
  await capture(page, 'integrations-stale', width, motion);
  await page.unroute('**/api/org/integrations', integrations);
}

function staleAppearance(node) {
  const tile = node.querySelector('.tile');
  const glyph = node.querySelector('[data-glyph]');
  const rowStyle = globalThis.getComputedStyle(node);
  const tileStyle = globalThis.getComputedStyle(tile);
  const glyphStyle = globalThis.getComputedStyle(glyph);
  return {
    rowBackground: rowStyle.backgroundColor,
    tileBackground: tileStyle.backgroundColor,
    tileOpacity: tileStyle.opacity,
    glyphOpacity: glyphStyle.opacity,
  };
}

function noticeTypography(node) {
  const style = globalThis.getComputedStyle(node);
  return [style.fontSize, style.fontWeight];
}

function nodeConnected(node) {
  return node.isConnected;
}

function noBusyStatus(node) {
  return node.closest('[aria-busy="true"]') === null;
}

async function checkStatusRegions(page) {
  for (const region of await page.locator('[role=status]').all()) {
    assert(await region.evaluate(noBusyStatus), 'Status region is outside busy content');
  }
}

const budget = {
  sequence: 2, defaultPayingGroupId: 'personal-default', periodStart: '2026-10-01T00:00:00Z',
  todayCents: 100, monthCents: 2500, reservedCents: 25, ceilingCents: 20000,
  dailyCeilingCents: 2000, ceilings: [],
};
const policy = {
  sequence: 12, connectionId: 'installed', accountMode: 'none', published: true,
  tools: [{ name: 'read', revision: 'a'.repeat(64), reviewed: true,
    readOnly: true, mode: 'block', suggestion: 'allow' }],
};

async function modelsReply(route) {
  await route.fulfill({ json: { budget, models: [{ id: 'Installed model' }] } });
}

async function policyReply(route) {
  await route.fulfill({ json: policy });
}

async function refuseInstall(route) {
  if (route.request().resourceType() !== 'fetch') return route.fallback();
  await route.fulfill({ status: 400, json: { status: 'refused' } });
}

function correctedInstallRequest(request) {
  if (request.method() !== 'POST') return false;
  const url = new URL(request.url());
  if (url.pathname !== '/api/org/integrations') return false;
  const body = request.postDataJSON();
  return body.locator === 'https://corrected.example/mcp';
}

async function submitCorrectedInstall(page, submission) {
  const address = page.getByLabel('Server URL');
  await address.fill('https://corrected.example/mcp');
  assert.equal(await address.inputValue(), 'https://corrected.example/mcp');
  const draftState = page.locator('oc-mcp-install [data-state=draft]');
  await draftState.waitFor();
  const discover = page.getByRole('button', { name: 'Discover tools' });
  assert.equal(await discover.isVisible(), true);
  const request = page.waitForRequest(correctedInstallRequest);
  if (submission === 'button') {
    await discover.click();
  } else {
    await address.press('Enter');
  }
  await request;
  const refusedState = page.locator('oc-mcp-install [data-state=refused]');
  await refusedState.waitFor();
}

async function refuseView(route) {
  await route.fulfill({ status: 403, json: { status: 'refused' } });
}

async function previewReply(route) {
  await route.fulfill({ contentType: 'text/plain', body: 'The board pack is ready for review.' });
}

async function checkEditors(page, width, motion) {
  await page.route('**/api/org/models', modelsReply);
  await page.goto(`${origin}/org/spending`);
  await page.getByText('Spending loaded', { exact: true }).waitFor();
  await checkStatusRegions(page);
  await capture(page, 'spending', width, motion);
  await page.route('**/api/org/integrations/installed/tools', policyReply);
  await page.goto(`${origin}/org/integrations/installed/tools`);
  await page.getByText('Choose a mode, then save the tool.', { exact: true }).waitFor();
  assert.equal(await page.locator('oc-tool-policy [data-state]').getAttribute('data-state'), 'ready');
  await checkStatusRegions(page);
  await capture(page, 'tool-policy', width, motion);
  await page.route('**/api/org/integrations', refuseInstall);
  await page.goto(`${origin}/org/integrations/new`);
  await page.getByLabel('Server URL').fill('https://private.example/mcp');
  await page.getByRole('button', { name: 'Discover tools' }).click();
  await page.getByText('This address was refused.', { exact: false }).waitFor();
  assert.equal(await page.locator('oc-mcp-install [data-state]').getAttribute('data-state'), 'refused');
  assert.equal(await page.getByRole('button', { name: 'Check status' }).count(), 0);
  assert.equal(await page.getByLabel('Server URL').isEnabled(), true);
  await submitCorrectedInstall(page, 'button');
  await submitCorrectedInstall(page, 'Enter');
  const sourceCard = page.locator('.sources .selected');
  await checkFold(sourceCard, 12);
  await checkStatusRegions(page);
  await capture(page, 'mcp-install', width, motion);
}

async function checkWorkspace(browser, width, motion, scenario) {
  const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: motion });
  try {
    await page.route(`${origin}/**`, interceptAssets);
    await chatFixture(page, scenario);
    const query = scenario === 'rail-loading' ? '' : '?conversation=chat';
    await page.goto(`${origin}/workspace${query}`);
    if (scenario === 'rail-loading') {
      await page.locator('.rail-loading').waitFor({ state: 'attached' });
      if (width === 390) await page.getByRole('button', { name: 'Open session navigation' }).click();
      await checkStatusRegions(page);
      await capture(page, 'workspace-grain', width, motion);
      return;
    }
    await page.locator('.citation').first().waitFor();
    await page.evaluate(fontsReady);
    await checkStatusRegions(page);
    await page.getByRole('textbox', { name: 'Message your agent' }).focus();
    assert.deepEqual(await page.locator('textarea').evaluate(focusRing),
      ['2px', 'rgb(10, 132, 151)', '2px']);
    if (scenario === 'streaming' && width === 390) {
      await page.getByRole('button', { name: 'Open session navigation' }).click();
    }
    const name = scenario === 'streaming' ? 'workspace-flutter' : 'chat-dogears';
    const citationPapers = page.locator('.citation-paper');
    const citationPaper = citationPapers.first();
    await checkFold(citationPaper, 6);
    await capture(page, name, width, motion);
    if (scenario === 'streaming') return;
    const citations = page.locator('.citation');
    const citation = citations.first();
    await checkPointerRing(page, citation);
    await page.keyboard.press('Tab');
    await citation.focus();
    await checkKeyboardRing(citation);
    await capture(page, 'citation-focus', width, motion);
    const fileCards = page.locator('.file-card.oc-dogear');
    const fileCard = fileCards.first();
    await checkFold(fileCard, 12);
    if (width === 390) {
      await page.getByRole('button', { name: 'Session panel', exact: true }).click();
    }
    const sessionFiles = page.locator('.panel-file.created:visible');
    const sessionFile = sessionFiles.first();
    await checkPointerRing(page, sessionFile);
    await page.keyboard.press('Tab');
    await sessionFile.focus();
    await checkKeyboardRing(sessionFile);
    const sessionPaper = sessionFile.locator('.panel-file-paper');
    await checkFold(sessionPaper, 12);
    await capture(page, 'panel-file-focus', width, motion);
    if (width === 390) await page.keyboard.press('Escape');
    await page.route('**/api/conversations/chat/files/view?*', previewReply);
    await page.locator('.file-card').getByRole('button', { name: 'Open', exact: true }).click();
    await page.getByText('Preview ready', { exact: true }).waitFor();
    await checkStatusRegions(page);
    await capture(page, 'file-preview', width, motion);
    await page.keyboard.press('Escape');
    await page.route('**/api/conversations/chat/view', refuseView);
    if (width === 390) await page.getByRole('button', { name: 'Session panel', exact: true }).click();
    await page.getByRole('button', { name: 'Watch your computer', exact: true }).click();
    await page.getByText('Unavailable', { exact: true }).waitFor();
    await checkStatusRegions(page);
    await capture(page, 'live-view', width, motion);
  } finally {
    await page.close();
  }
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
      await checkEditors(page, width, motion);
      for (const scenario of ['rail-loading', 'streaming', 'live']) {
        await checkWorkspace(browser, width, motion, scenario);
      }
      await page.close();
    }
  }
  const gitOptions = { encoding: 'utf8' };
  const revisionOutput = execFileSync('git', ['rev-parse', 'HEAD'], gitOptions);
  const revision = revisionOutput.trim();
  const result = {
    result: 'PASS', date: new Date().toISOString(), source: revision,
    screenComparison: 'PARTIAL: shared treatments match; existing screens retain their fields and shells',
    freshInstall: false, liveQualification: 'NOT RUN: intercepted fixtures only', widths: [1280, 390], motion: ['no-preference', 'reduce'],
    captures: 56, environment: 'Built Angular assets; Chromium; intercepted protocol fixtures; no stack',
    checks: ['Eleven families', 'Silent repeated rows', 'Single progress region', '44px phone tabs',
      'Arrow keys and Home', '2px focus ring', 'Refresh retains focus and rows', 'No overflow',
      'Busy content excludes status regions', 'Specific call-site states',
      '80px desktop rows', 'Composer focus ring',
      'Corrected refused address submits by button and Enter',
      'Citation and session file keyboard focus outside clipped folds',
      'Pointer focus does not draw a keyboard ring',
      'Citation dog-ears', '12px dog-ear', '42% rice texture', 'Static reduced-motion loaders'],
  };
  await writeFile(`${output}/visual.json`, JSON.stringify(result, null, 2) + '\n');
  console.log('PASS F1 foundation: 56 captures, states, register, keyboard and reduced motion');
} finally {
  await browser.close();
}
