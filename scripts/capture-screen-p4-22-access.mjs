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
  if (state.holdReads?.includes(path)) {
    state.held.set(path, route);
    return;
  }
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
    if (kind === 'member' && state.slowCandidates) await delay(700);
    response = json({ rows: [{ id: `${kind}-two`, displayName: `${kind} candidate`,
      memberCount: kind === 'team' ? 12 : undefined }], next: null, loadedAt: time,
      projection: access.projection });
  } else {
    if (state.slow) await delay(800);
    response = state.failList ? json({ status: 'unavailable' }, 503) : json(state.list);
  }
  if (state.deny && path.startsWith(base)
    && (!state.denyPath || path.includes(state.denyPath))) response = json({ status: 'refused' }, state.deny);
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
  async function serveRequest(route) { await serve(route, state); }
  await page.route(`${origin}/**`, serveRequest);
  await page.goto(`${origin}/org/models`);
  const opener = page.getByRole('button', { name: 'Access', exact: true }).first();
  await opener.click();
  const dialog = page.getByRole('dialog');
  return { page, state, dialog, opener };
}
async function capture(page, name, width) {
  if (process.argv.includes('--check')) return;
  await page.evaluate(fontsReady);
  const problems = await page.evaluate(layoutProblems);
  assert.deepEqual(problems, []);
  await page.screenshot({ path: resolve(output, `${name}-${width}.png`), fullPage: true });
}
async function fontsReady() { await document.fonts.ready; }
function layoutProblems() {
  const result = [];
  if (document.documentElement.scrollWidth > window.innerWidth) result.push('overflow');
  for (const target of document.querySelectorAll('dialog[open] button, dialog[open] select')) {
    const bounds = target.getBoundingClientRect();
    if (bounds.width && (bounds.width < 44 || bounds.height < 44)) result.push('small target');
  }
  return result;
}
function hasFocus(element) { return element === document.activeElement; }

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
  assert.equal(await run.opener.evaluate(hasFocus), true);
  await run.opener.click();
  run.state.current = true;
  run.state.list = { ...access, expectedSequence: 5, grants: [], grantTotal: 0 };
  await run.dialog.getByRole('button', { name: 'Check status', exact: true }).click();
  assert.equal(await run.dialog.getByText('Saved', { exact: true }).count(), 0);
  await run.dialog.getByText('Saved', { exact: true }).waitFor();
  assert.equal(run.state.posts.length, 1);
  await capture(run.page, 'MOD-31-saved', width);
  await run.dialog.getByRole('button', { name: 'Back', exact: true }).click();
  assert.equal(await run.opener.evaluate(hasFocus), true);
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
async function additionalCases(browser) {
  for (const reason of ['model_unavailable', 'target_unavailable', 'target_changed']) {
    const run = await open(browser, 1280, { mode: 'refused', code: 409, reason });
    await remove(run.dialog);
    const sentences = { model_unavailable: 'This model is no longer available for this change.',
      target_unavailable: 'This person, group or assistant is no longer available.',
      target_changed: 'This person or assistant changed during the access check.' };
    await run.dialog.getByText(sentences[reason], { exact: true }).waitFor();
    run.state.failList = true;
    await run.dialog.getByRole('button', { name: 'Refresh', exact: true }).click();
    await delay(150);
    assert.equal(await run.dialog.getByRole('button', { name: 'Remove' }).isDisabled(), true);
    await run.page.close();
  }
  let run = await open(browser, 1280, { slowCandidates: true });
  await run.dialog.getByRole('button', { name: 'Person', exact: true }).click();
  await run.dialog.getByRole('button', { name: 'Group', exact: true }).click();
  await run.dialog.getByText('12 joined members', { exact: true }).waitFor();
  await delay(800);
  assert.equal(await run.dialog.getByText('member candidate', { exact: true }).count(), 0);
  await run.dialog.getByRole('button', { name: 'Grant', exact: true }).click();
  await run.dialog.getByText('One row selected: Grant.', { exact: true }).waitFor();
  assert.equal(await run.dialog.getByRole('button', { name: 'Remove' }).isDisabled(), true);
  await run.dialog.getByRole('button', { name: 'Save access', exact: true }).click();
  await delay(200);
  assert.equal(run.state.posts[0].action, 'grant');
  assert.equal(run.state.posts[0].granteeKind, 'team');
  const candidateReads = run.state.requests.filter(isCandidateRead);
  assert.deepEqual(candidateReads.map(queryOf), ['?kind=member&limit=50', '?kind=team&limit=50']);
  await run.page.close();
  run = await open(browser, 1280, { list: { ...access, grants: [], grantTotal: 101 } });
  await run.dialog.getByText('Showing 0 of 101', { exact: true }).waitFor();
  assert.equal(await run.dialog.getByText('No audience yet', { exact: true }).count(), 0);
  await run.page.close();
  for (const deny of [401, 403]) {
    for (const denyPath of ['', '/candidates', '/changes']) {
      run = await open(browser, 1280, { slowCandidates: true });
      await run.dialog.getByText('Sales team', { exact: true }).waitFor();
      await run.dialog.getByRole('button', { name: 'Person', exact: true }).click();
      run.state.deny = deny;
      run.state.denyPath = denyPath;
      if (denyPath !== '/candidates') await remove(run.dialog);
      await run.dialog.getByText('Access lost. Details cleared.', { exact: true }).waitFor();
      await delay(800);
      assert.equal(await run.dialog.locator('article').count(), 0);
      assert.equal(await run.dialog.getByRole('button', { name: 'Save access' }).count(), 0);
      await run.page.close();
    }
  }
  run = await open(browser, 1280, { mode: 'unknown', code: 503 });
  await remove(run.dialog);
  await run.dialog.getByText('Outcome unknown', { exact: true }).waitFor();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await run.dialog.getByRole('button', { name: 'Check status', exact: true }).click();
    await delay(100);
  }
  assert.equal(run.state.posts.length, 1);
  const checks = run.state.requests.filter(isStatusRead);
  for (const check of checks) assert.equal(check.path, `${base}/changes/${run.state.posts[0].commandId}`);
  await run.page.close();
}
async function parentDenialCases(browser) {
  for (const deniedPath of ['/api/org/providers', '/api/org/models']) {
    for (const status of [401, 403]) {
      const run = await open(browser, 1280);
      try {
        await run.dialog.getByText('Sales team', { exact: true }).waitFor();
        await run.page.keyboard.press('Escape');
        run.state.held = new Map();
        run.state.holdReads = ['/api/org/providers', '/api/org/models', `${base}/candidates`];
        await run.page.getByRole('button', { name: 'Refresh', exact: true }).click();
        await run.opener.click();
        await run.dialog.getByText('Sales team', { exact: true }).waitFor();
        await run.dialog.getByRole('button', { name: 'Person', exact: true }).click();
        await run.dialog.getByRole('button', { name: 'Remove', exact: true }).click();
        await run.dialog.getByText('One row selected: Remove.', { exact: true }).waitFor();
        assert.equal(await run.dialog.getByRole('button', { name: 'Save access' }).isEnabled(), true);
        assert.equal(run.state.held.size, 3);
        const refusal = run.state.held.get(deniedPath);
        await refusal.fulfill(json({ status: 'refused' }, status));
        // Keep the other parent read pending until all protected rows and controls disappear.
        await run.dialog.getByText('Access lost. Details cleared.', { exact: true })
          .waitFor({ timeout: 1000 });
        assert.equal(await run.dialog.locator('article').count(), 0);
        assert.equal(await run.dialog.getByRole('button', { name: 'Save access' }).count(), 0);
        assert.equal(await run.page.getByRole('button', { name: 'Access', exact: true }).count(), 0);
        const candidateRead = run.state.held.get(`${base}/candidates`);
        const candidates = { rows: [{ id: 'late-person', displayName: 'Late person' }],
          next: null, loadedAt: time, projection: access.projection };
        await candidateRead.fulfill(json(candidates));
        const pendingPath = deniedPath === '/api/org/providers'
          ? '/api/org/models' : '/api/org/providers';
        const pendingRead = run.state.held.get(pendingPath);
        run.state.holdReads = [];
        await serve(pendingRead, run.state);
        await delay(100);
        assert.equal(await run.dialog.locator('article').count(), 0);
        assert.equal(await run.dialog.getByText('Late person', { exact: true }).count(), 0);
        assert.equal(await run.page.getByRole('button', { name: 'Access', exact: true }).count(), 0);
        process.stdout.write(`PASS immediate parent denial ${deniedPath} ${status}\n`);
      } finally {
        await run.page.close();
      }
    }
  }
}
function isCandidateRead(request) { return request.path.endsWith('/candidates'); }
function isStatusRead(request) { return request.path.includes('/changes/'); }
function queryOf(request) { return request.query; }
await mkdir(output, { recursive: true });
const browser = await chromium.launch();
try {
  await parentDenialCases(browser);
  if (!process.argv.includes('--parent-denial-only')) {
    for (const width of [1280, 390]) await cases(browser, width);
    await additionalCases(browser);
  }
} finally {
  await browser.close();
}
process.stdout.write('PASS model access checks\n');
