/* global document, window, HTMLInputElement, getComputedStyle */
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { chromium } from 'playwright';

const output = resolve('docs/process/p4-21-screens');
const build = resolve('apps/web/dist/web/browser');
const origin = 'https://p4-21-screens.opencrane.test';
const widths = [1280, 390, 320];
const motions = ['normal', 'reduced'];
const captures = [];
const routing = { chat_turn: { model: 'gpt-6.1-sol', reason: 'Chat' },
  deep_analysis: { model: 'gpt-6-astra', reason: 'Detailed analysis' } };

function provider(providerId, name, changes = {}) {
  const savedFact = Object.hasOwn(changes, 'saved') ? changes.saved
    : { changeId: `saved-${providerId}`, time: '2026-10-07T08:00:00Z', revision: 2,
      outcome: 'recorded' };
  return { providerId, provider: 'openai', name, revision: changes.revision ?? 2, position: 2,
    saved: savedFact, reachable: changes.reachable,
    modelAnswer: changes.modelAnswer, enabledModels: changes.enabledModels ?? [],
    status: changes.status ?? 'saved_unverified' };
}

function state() {
  return { providers: [], createdCommands: [], changes: new Map(), failReads: false,
    forbidden: false, loseNextKeyReply: false, unknownPrice: false, failModelTest: false,
    delayNextKeyMs: 0 };
}

function json(body, status = 200) {
  return { status, contentType: 'application/json', body: JSON.stringify(body) };
}

function receipt(providerId, revision, operation, commandId, sequence) {
  return { status: 'appended', providerId, revision, operation, sequence, changeId: commandId };
}

async function assetsAndApi(route, testState) {
  const request = route.request();
  const url = new URL(request.url());
  const path = url.pathname;
  if (path.startsWith('/api/org/providers')) {
    const response = await providerApi(request, path, url, testState);
    await route.fulfill(response);
    return;
  }
  if (path === '/api/org/models') {
    await route.fulfill(json({ models: [{ id: 'gpt-6.1-sol', retired: false },
      { id: 'gpt-6-astra', retired: false }], taskRouting: routing }));
    return;
  }
  let filename = resolve(build, `.${path}`);
  if (!extname(filename)) filename = resolve(build, 'index.html');
  if (!filename.startsWith(`${build}/`)) {
    await route.abort();
    return;
  }
  const contentType = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
    '.woff2': 'font/woff2', '.svg': 'image/svg+xml' }[extname(filename)];
  await route.fulfill({ body: await readFile(filename), contentType });
}

async function providerApi(request, path, url, testState) {
  if (path === '/api/org/providers' && request.method() === 'GET') {
    if (testState.forbidden) return json({ status: 'refused' }, 403);
    if (testState.failReads) {
      testState.failReads = false;
      return json({ status: 'unavailable' }, 503);
    }
    return json({ rows: testState.providers, loadedAt: '2026-10-07T09:00:00Z',
      access: { grantsAvailable: false, reason: 'p4_22_required' } });
  }
  if (path === '/api/org/providers' && request.method() === 'POST') {
    const body = request.postDataJSON();
    if (body.action === 'create') {
      testState.createdCommands.push(body);
      testState.providers.push(provider(body.providerId, body.name,
        { revision: 1, saved: undefined, status: 'needs_key' }));
      const savedReceipt = receipt(body.providerId, 1, 'provider.created', body.commandId, 1);
      testState.changes.set(body.commandId, change(savedReceipt));
      return json(savedReceipt);
    }
    const row = findProvider(testState, body.providerId);
    if (!row) return json({ status: 'refused' }, 409);
    row.revision += 1;
    row.position += 1;
    row.enabledModels = body.models;
    const savedReceipt = receipt(row.providerId, row.revision, 'provider.models_selected',
      body.commandId, row.position);
    testState.changes.set(body.commandId, change(savedReceipt));
    return json(savedReceipt);
  }
  const changePath = /^\/api\/org\/providers\/([^/]+)\/changes\/([^/]+)$/u.exec(path);
  if (changePath && request.method() === 'GET') {
    const found = testState.changes.get(decodeURIComponent(changePath[2] ?? ''));
    return found ? json(found) : json({ status: 'not_found' }, 404);
  }
  const rowMatch = /^\/api\/org\/providers\/([^/]+)$/u.exec(path);
  if (rowMatch && request.method() === 'GET') {
    const row = findProvider(testState, decodeURIComponent(rowMatch[1] ?? ''));
    return json({ rows: row ? [row] : [] });
  }
  const keyMatch = /^\/api\/org\/providers\/([^/]+)\/key$/u.exec(path);
  if (keyMatch && request.method() === 'POST') {
    const body = request.postDataJSON();
    const row = findProvider(testState, decodeURIComponent(keyMatch[1] ?? ''));
    if (!row) return json({ status: 'refused' }, 409);
    row.revision += 1;
    row.position += 1;
    row.saved = { changeId: body.commandId, time: '2026-10-07T09:00:00Z',
      revision: row.revision, outcome: 'recorded' };
    row.reachable = undefined;
    row.modelAnswer = undefined;
    const savedReceipt = receipt(row.providerId, row.revision, 'provider.key_saved',
      body.commandId, row.position);
    testState.changes.set(body.commandId, change(savedReceipt));
    const delay = testState.delayNextKeyMs;
    testState.delayNextKeyMs = 0;
    if (delay > 0) await wait(delay);
    if (testState.loseNextKeyReply) {
      testState.loseNextKeyReply = false;
      return json({ status: 'unavailable' }, 503);
    }
    return json({ ...savedReceipt, clearKey: true });
  }
  if (path.endsWith('/verify') && request.method() === 'GET') {
    if (testState.unknownPrice) return json({ status: 'refused', reason: 'unknown_price' }, 403);
    return json({ providerId: path.split('/')[4], revision: 2,
      model: url.searchParams.get('model'), priceTableId: 'openai-2026-10-02-all-eur95',
      reservedCents: 1, consentRequired: true });
  }
  if (path.endsWith('/verify') && request.method() === 'POST') {
    const body = request.postDataJSON();
    const providerId = path.split('/')[4];
    const row = findProvider(testState, providerId);
    if (!row) return json({ status: 'refused' }, 409);
    row.position += 1;
    const isReachability = body.action === 'reachability';
    const kind = isReachability ? 'reachability' : 'model';
    const outcome = body.action === 'skip' ? 'skipped'
      : testState.failModelTest && body.action === 'test' ? 'fail' : 'pass';
    const fact = { changeId: body.commandId, attemptId: body.commandId, time: '2026-10-07T09:02:00Z',
      revision: row.revision, outcome, kind, model: body.model,
      reservedCents: body.reservedCents, settledCents: body.action === 'test' ? 1 : undefined };
    if (isReachability) row.reachable = fact;
    else row.modelAnswer = fact;
    const savedReceipt = receipt(providerId, row.revision, 'provider.verification_requested',
      body.commandId, row.position);
    testState.changes.set(body.commandId, change({ ...savedReceipt, outcome }));
    return json(savedReceipt);
  }
  return json({ status: 'not_found' }, 404);
}

function change(savedReceipt) {
  return { ...savedReceipt, projection: { content: 'current', iam: 'current' },
    currentRevision: savedReceipt.revision, verificationValid: true };
}

function findProvider(testState, providerId) {
  return testState.providers.find(matchesProvider(providerId));
}

function matchesProvider(providerId) {
  return row => row.providerId === providerId;
}

function wait(duration) {
  return new Promise(resolveWait.bind(null, duration));
}

function resolveWait(duration, resolvePromise) {
  globalThis.setTimeout(resolvePromise, duration);
}

function noOverflow() {
  return document.documentElement.scrollWidth <= window.innerWidth;
}

function smallTargets() {
  const targets = [...document.querySelectorAll('main button, main a, main input, dialog[open] button, '
    + 'dialog[open] a, dialog[open] input, main .choice-card, main .model-choice, '
    + 'main .consent-row, dialog[open] .choice-card, dialog[open] .model-choice, '
    + 'dialog[open] .consent-row')];
  const small = [];
  for (const target of targets) {
    if (target.classList.contains('implicit-submit')) continue;
    if (target instanceof HTMLInputElement && ['checkbox', 'radio'].includes(target.type)) continue;
    const bounds = target.getBoundingClientRect();
    if (bounds.width === 0 || bounds.height === 0) continue;
    if (bounds.width < 43.5 || bounds.height < 43.5) {
      small.push({ text: target.textContent?.trim(), width: bounds.width, height: bounds.height });
    }
  }
  return small;
}

function buttonForegroundColors(buttons) {
  const colors = [];
  for (const button of buttons) colors.push(getComputedStyle(button).color);
  return colors;
}

async function capture(page, name, width, motion) {
  assert.equal(await page.evaluate(noOverflow), true, `${name} has no horizontal overflow at ${width}`);
  const targets = await page.evaluate(smallTargets);
  assert.deepEqual(targets, [], `${name} has touch targets at least 44px at ${width}`);
  const liveRegions = await page.locator('[role="status"][aria-live="polite"]').count();
  assert.equal(liveRegions, 1, `${name} has one live status region`);
  const tealText = await page.locator('button.primary').evaluateAll(buttonForegroundColors);
  assert.equal(tealText.some(color => color === 'rgb(255, 255, 255)'), false,
    `${name} does not put white text on the teal accent`);
  await page.screenshot({ path: resolve(output, `${name}-${width}-${motion}.png`), fullPage: true });
  captures.push({ name, width, motion });
}

async function openPage(browser, width, motion, testState) {
  const page = await browser.newPage({ viewport: { width, height: 1000 } });
  const setting = motion === 'reduced' ? 'reduce' : 'no-preference';
  await page.emulateMedia({ reducedMotion: setting });
  await page.route(`${origin}/**`, route => assetsAndApi(route, testState));
  await page.goto(`${origin}/org/models`);
  await page.locator('main h1').waitFor();
  await page.locator('.page-actions .button.primary').waitFor();
  return page;
}

async function captureListStates(browser, width, motion) {
  const emptyState = state();
  let page = await openPage(browser, width, motion, emptyState);
  await capture(page, 'MOD-01-empty', width, motion);
  await page.close();

  const loadedState = state();
  loadedState.providers = [provider('primary', 'Primary')];
  page = await openPage(browser, width, motion, loadedState);
  await capture(page, motion === 'reduced' ? 'MOD-02-RM' : 'MOD-02-ready', width, motion);
  if (width <= 700) {
    await page.getByRole('button', { name: 'Open organisation navigation' }).click();
    await page.waitForTimeout(450);
    await capture(page, 'MOD-06-menu', width, motion);
    await page.getByRole('button', { name: 'Close navigation' }).click();
    await page.locator('oc-navigation-menu dialog[open]').waitFor({ state: 'hidden' });
  }
  if (width > 0 && motion === 'normal') {
    loadedState.failReads = true;
    await page.getByRole('button', { name: 'Refresh' }).click();
    await page.getByText('Showing the last data loaded').waitFor();
    await capture(page, 'MOD-03-stale-read', width, motion);
  }
  await page.close();

  if (width > 0 && motion === 'normal') {
    const deniedState = state();
    deniedState.forbidden = true;
    page = await openPage(browser, width, motion, deniedState);
    await page.getByText('Owner or Admin role required').waitFor();
    await capture(page, 'MOD-04-role-needed', width, motion);
    await page.close();
  }
}

async function captureSetup(browser, width, motion) {
  const testState = state();
  testState.delayNextKeyMs = 550;
  const page = await openPage(browser, width, motion, testState);
  await page.locator('.page-actions .button.primary').click();
  await page.getByLabel('Connection name Required').fill('Primary');
  await capture(page, 'MOD-10-provider', width, motion);
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.locator('#provider-key').fill('stub-key-do-not-display');
  await capture(page, 'MOD-11-key', width, motion);
  await page.getByRole('button', { name: 'Save key' }).click();
  await page.getByRole('button', { name: 'Saving key…' }).waitFor();
  await capture(page, 'MOD-12-saving-key', width, motion);
  await page.getByText('Step 3 of 6').waitFor();
  assert.equal(await page.locator('#provider-key').count(), 0,
    'saved key input is removed after the save receipt');
  await capture(page, 'MOD-13-saved-unverified', width, motion);
  await page.getByRole('button', { name: 'Check provider reachability' }).click();
  await page.getByRole('button', { name: 'Read current price' }).waitFor();
  await page.getByRole('button', { name: 'Read current price' }).click();
  await page.getByText('A short request may reserve up to').waitFor();
  await capture(page, 'MOD-14-priced-warning', width, motion);
  await page.getByLabel(/I agree to one priced test request/).check();
  await page.getByRole('button', { name: 'Run priced test' }).click();
  await page.getByText('gpt-6.1-sol answered').waitFor();
  await capture(page, 'MOD-15-model-answer-stub', width, motion);
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByText('Step 4 of 6').waitFor();
  await capture(page, 'MOD-19-models', width, motion);
  const firstModel = page.locator('.model-choice input').first();
  await firstModel.check();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByText('Step 5 of 6').waitFor();
  await capture(page, 'MOD-20-access-gap', width, motion);
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByText('Step 6 of 6').waitFor();
  await capture(page, 'MOD-21-done', width, motion);
  await page.close();
}

async function captureRemainingStates(browser, width, motion) {
  const detailState = state();
  detailState.providers = [provider('detail', 'Primary')];
  let page = await openPage(browser, width, motion, detailState);
  await page.getByRole('button', { name: 'Open OpenAI provider Primary' }).click();
  await page.getByText('Step 3 of 6').waitFor();
  await capture(page, 'MOD-05-provider-facts', width, motion);
  await page.close();

  const skipState = state();
  page = await openPage(browser, width, motion, skipState);
  await setupReachableProvider(page);
  await page.getByRole('button', { name: 'Skip — Connected, not tested' }).click();
  await page.getByRole('status').getByText('Connected, not tested.').waitFor();
  await capture(page, 'MOD-16-connected-not-tested', width, motion);
  await page.close();

  const refusedState = state();
  page = await openPage(browser, width, motion, refusedState);
  await setupReachableProvider(page);
  refusedState.unknownPrice = true;
  await page.getByRole('button', { name: 'Read current price' }).click();
  await page.getByText('No price is available for this model').waitFor();
  await capture(page, 'MOD-17-test-refused', width, motion);
  await page.close();

  const pendingState = state();
  pendingState.providers = [provider('rotate', 'Primary')];
  pendingState.loseNextKeyReply = true;
  page = await openPage(browser, width, motion, pendingState);
  await page.getByRole('button', { name: 'Replace key' }).click();
  await capture(page, 'MOD-25-replace-review', width, motion);
  await page.locator('#replace-provider-key').fill('rotated-stub-key');
  await page.getByRole('button', { name: 'Replace key' }).last().click();
  await page.getByText('The key outcome is unknown. Check status before sending again.')
    .waitFor();
  await capture(page, 'MOD-18-lost-key-reply', width, motion);
  await page.getByRole('dialog').getByRole('button', { name: 'Check status' }).click();
  await page.getByRole('status').filter({ hasText: 'Key save confirmed' }).waitFor();
  await page.getByText('Saved, not verified').waitFor();
  await capture(page, 'MOD-26-key-accepted', width, motion);
  await page.close();
}

async function setupReachableProvider(page) {
  await page.locator('.page-actions .button.primary').click();
  await page.getByLabel('Connection name Required').fill('Primary');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.locator('#provider-key').fill('stub-key-not-real');
  await page.getByRole('button', { name: 'Save key' }).click();
  await page.getByText('Step 3 of 6').waitFor();
  await page.getByRole('button', { name: 'Check provider reachability' }).click();
  await page.getByRole('button', { name: 'Read current price' }).waitFor();
}

async function main() {
  await mkdir(output, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  for (const width of widths) {
    for (const motion of motions) {
      await captureListStates(browser, width, motion);
      await captureSetup(browser, width, motion);
      await captureRemainingStates(browser, width, motion);
    }
  }
  await browser.close();
  const summary = { result: 'PASS', captures };
  const { writeFile } = await import('node:fs/promises');
  await writeFile(resolve(output, 'captures.json'), JSON.stringify(summary, null, 2) + '\n');
  process.stdout.write(`PASS ${captures.length} responsive screen captures\n`);
}

await main();
