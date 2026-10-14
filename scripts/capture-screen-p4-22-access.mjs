/* global document, window */
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

const output = resolve('docs/process/screen-p4-22-access');
const build = resolve('apps/web/dist/web/browser');
const origin = 'https://model-access.opencrane.test';
const modelId = 'gpt-6.1-sol';
const base = `/api/org/models/${modelId}/access`;
const time = '2026-10-14T09:00:00Z';
const unavailable = { status: 'not_available_yet' };
const grant = { granteeKind: 'team', granteeId: 'sales', displayName: 'Sales team',
  source: 'group', state: 'granted', eventId: 'grant-one', eventTime: time,
  sequence: 4, projection: 'current' };
const access = { modelId, expectedSequence: 4, loadedAt: time, canManage: true,
  grants: [grant], grantTotal: 1, explanations: { configuredUses: unavailable },
  availability: { registrySupported: true, selectedConnection: unavailable,
    enabledModel: unavailable, connection: unavailable, key: unavailable, verification: unavailable },
  projection: { content: 'current', sequence: 4 } };

function json(body, status = 200) {
  return { status, contentType: 'application/json', body: JSON.stringify(body) };
}
async function serve(route, state) {
  const request = route.request();
  const url = new URL(request.url());
  const path = url.pathname;
  if (!path.startsWith('/api/')) {
    let file = resolve(build, `.${path}`);
    if (!extname(file)) file = resolve(build, 'index.html');
    assert.ok(file.startsWith(`${build}/`));
    const contentType = { '.html': 'text/html', '.js': 'text/javascript',
      '.css': 'text/css', '.woff2': 'font/woff2' }[extname(file)];
    await route.fulfill({ body: await readFile(file), contentType });
    return;
  }
  state.requests.push({ path, query: url.search, method: request.method() });
  let response;
  if (path === '/api/org/providers') {
    response = json({ rows: [], loadedAt: time,
      access: { grantsAvailable: true, reason: 'model_access_routes' } });
  } else if (path === '/api/org/models') {
    response = json({ models: [{ id: modelId, retired: false }],
      taskRouting: { chat_turn: { model: modelId, reason: 'Chat' } } });
  } else if (request.method() === 'POST') {
    state.posts.push(request.postDataJSON());
    await delay(80);
    if (state.mode === 'network') return route.abort();
    response = json({ status: state.mode, reason: state.reason }, state.code);
    if (state.mode === 'appended') response = json(receipt(state));
  } else if (path.includes('/changes/')) {
    state.statusReads += 1;
    response = json({ ...receipt(state), currentSequence: 5,
      projection: { content: 'current', iam: state.current ? 'current' : 'applying' } });
    if (state.mode === 'unknown' || state.mode === 'network') {
      response = json({ status: 'unknown' }, 404);
    }
  } else if (path.endsWith('/candidates')) {
    const kind = url.searchParams.get('kind');
    response = json({ rows: [{ id: `${kind}-two`, displayName: `${kind} candidate`,
      memberCount: kind === 'team' ? 12 : undefined }], next: null, loadedAt: time,
      projection: access.projection });
  } else {
    if (state.slow) await delay(800);
    response = json(state.list);
  }
  if (state.deny && path.startsWith(base)) response = json({ status: 'refused' }, state.deny);
  await route.fulfill(response);
}
function receipt(state) {
  return { status: 'appended', modelId, commandId: state.posts[0]?.commandId,
    operation: 'grant.revoked', sequence: 5, changeId: 'change-one' };
}
async function open(browser, width, patch = {}) {
  const state = { mode: 'appended', code: 200, list: access, posts: [], requests: [],
    current: false, statusReads: 0, ...patch };
  const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(5000);
  await page.route(`${origin}/**`, route => serve(route, state));
  await page.goto(`${origin}/org/models`);
  const opener = page.getByRole('button', { name: 'Access', exact: true }).first();
  await opener.click();
  const dialog = page.getByRole('dialog');
  return { page, state, dialog, opener };
}
async function capture(page, name, width) {
  await page.evaluate(async function fontsReady() { await document.fonts.ready; });
  const problems = await page.evaluate(function layoutProblems() {
    const result = [];
    if (document.documentElement.scrollWidth > window.innerWidth) result.push('overflow');
    for (const target of document.querySelectorAll('dialog[open] button, dialog[open] select')) {
      const bounds = target.getBoundingClientRect();
      if (bounds.width && (bounds.width < 44 || bounds.height < 44)) result.push('small target');
    }
    return result;
  });
  assert.deepEqual(problems, []);
  await page.screenshot({ path: resolve(output, `${name}-${width}.png`), fullPage: true });
}
async function remove(dialog) {
  await dialog.getByRole('button', { name: 'Remove', exact: true }).click();
  await dialog.getByRole('button', { name: 'Save access', exact: true }).dblclick();
}
async function cases(browser, width) {
  let run = await open(browser, width, { slow: true });
  await run.dialog.getByText('Loading access…', { exact: true }).waitFor();
  await capture(run.page, 'MOD-31-loading', width);
  await run.dialog.getByText('Sales team', { exact: true }).waitFor();
  await capture(run.page, 'MOD-30', width);
  await remove(run.dialog);
  await run.dialog.getByText('Applying', { exact: true }).first().waitFor();
  assert.equal(run.state.posts.length, 1);
  assert.match(run.state.posts[0].commandId, /^[\w-]+$/u);
  assert.deepEqual(run.state.posts[0], { commandId: run.state.posts[0].commandId,
    expectedSequence: 4, action: 'revoke', granteeKind: 'team', granteeId: 'sales' });
  await run.page.keyboard.press('Escape');
  assert.equal(await run.opener.evaluate(element => element === document.activeElement), true);
  await run.opener.click();
  run.state.current = true;
  run.state.list = { ...access, expectedSequence: 5, grants: [], grantTotal: 0 };
  await run.dialog.getByRole('button', { name: 'Check status', exact: true }).click();
  await run.dialog.getByText('Saved', { exact: true }).waitFor();
  assert.equal(run.state.posts.length, 1);
  await capture(run.page, 'MOD-31-saved', width);
  await run.dialog.getByRole('button', { name: 'Back', exact: true }).click();
  assert.equal(await run.opener.evaluate(element => element === document.activeElement), true);
  await run.page.close();

  for (const [mode, code, message, action] of [
    ['no_effect', 200, 'Nothing to remove', null],
    ['refused', 409, 'Access changed. Review before saving.', 'Refresh'],
    ['unavailable', 503, 'Nothing changed', 'Try again'],
    ['unknown', 503, 'Outcome unknown', 'Check status'],
    ['network', 503, 'Outcome unknown', 'Check status'],
  ]) {
    run = await open(browser, width, { mode, code });
    await remove(run.dialog);
    await run.dialog.getByText(message, { exact: true }).waitFor();
    if (mode !== 'network' && mode !== 'no_effect') {
      const label = { refused: 'conflict', unavailable: 'nothing-changed', unknown: 'unknown' };
      await capture(run.page, `MOD-31-${label[mode]}`, width);
    }
    if (action) {
      await run.dialog.getByRole('button', { name: action, exact: true }).click();
      await delay(200);
    }
    if (mode === 'unavailable') assert.deepEqual(run.state.posts[1], run.state.posts[0]);
    else assert.equal(run.state.posts.length, 1);
    if (mode === 'no_effect') assert.equal(run.state.statusReads, 0);
    await run.page.close();
  }
  run = await open(browser, width, { list: { ...access, grants: [], grantTotal: 0 } });
  await run.dialog.getByText('No audience yet', { exact: true }).waitFor();
  await capture(run.page, 'MOD-31-no-audience', width);
  await run.page.close();
  run = await open(browser, width, { deny: 403 });
  await run.dialog.getByText('Access lost. Details cleared.', { exact: true }).waitFor();
  assert.equal(await run.dialog.getByText('Sales team', { exact: true }).count(), 0);
  await capture(run.page, 'MOD-31-access-lost', width);
  await run.page.close();
}
await mkdir(output, { recursive: true });
const browser = await chromium.launch();
try {
  for (const width of [1280, 390]) await cases(browser, width);
} finally {
  await browser.close();
}
process.stdout.write('PASS model access controls and 16 responsive captures\n');
