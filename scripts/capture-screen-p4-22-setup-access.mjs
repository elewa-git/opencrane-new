/* global document, window */
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { chromium } from 'playwright';

const output = resolve('docs/process/screen-p4-22-setup-access');
const build = resolve('apps/web/dist/web/browser');
const origin = 'https://setup-access.opencrane.test';
const time = '2026-10-14T09:00:00Z';
const unavailable = { status: 'not_available_yet' };
const models = ['gpt-6.1-sol', 'gpt-6-astra'];
const grant = { granteeKind: 'team', granteeId: 'sales', displayName: 'Sales team',
  source: 'group', state: 'granted', eventId: 'grant-one', eventTime: time,
  sequence: 4, projection: 'current' };
const fact = { changeId: 'saved', time, revision: 2, outcome: 'pass' };
function json(body) { return { contentType: 'application/json', body: JSON.stringify(body) }; }
async function serve(route, state) {
  const request = route.request();
  const path = new URL(request.url()).pathname;
  if (!path.startsWith('/api/')) {
    let file = resolve(build, `.${path}`);
    if (!extname(file)) file = resolve(build, 'index.html');
    assert.ok(file.startsWith(`${build}/`));
    const contentType = { '.html': 'text/html', '.js': 'text/javascript',
      '.css': 'text/css', '.woff2': 'font/woff2' }[extname(file)];
    return route.fulfill({ body: await readFile(file), contentType });
  }
  const modelId = path.split('/')[4];
  let body;
  if (path === '/api/org/models') {
    body = { models: [{ id: models[0] }, { id: models[1] }], taskRouting: {} };
  } else if (path.includes('/access')) {
    const command = state.posts.get(modelId);
    const receipt = { status: 'appended', modelId, commandId: command?.commandId,
      operation: 'grant.given', sequence: 5, changeId: 'grant-change' };
    if (request.method() === 'POST') {
      state.posts.set(modelId, request.postDataJSON());
      if (modelId === models[1]) return route.abort();
      return route.fulfill(json({ ...receipt, commandId: state.posts.get(modelId).commandId }));
    }
    if (path.includes('/changes/')) {
      body = { ...receipt, currentSequence: 5,
        projection: { content: 'current', iam: 'current' } };
    } else if (path.endsWith('/candidates')) {
      body = { rows: [{ id: 'helper', displayName: 'Sales assistant' }], next: null,
        loadedAt: time, projection: { content: 'current', sequence: 4 } };
    } else {
      body = { modelId, expectedSequence: 5, loadedAt: time, canManage: true,
        grants: [grant], grantTotal: 1, explanations: { configuredUses: unavailable },
        availability: { registrySupported: true, selectedConnection: unavailable,
          enabledModel: unavailable, connection: unavailable, key: unavailable,
          verification: unavailable }, projection: { content: 'current', sequence: 5 } };
    }
  } else if (request.method() === 'POST' || path.includes('/changes/')) {
    state.modelsSaved = true;
    body = { status: 'appended', operation: 'provider.models_selected',
      projection: { content: 'current', iam: 'current' } };
  } else {
    body = { rows: [{ providerId: 'fixture', provider: 'openai', name: 'Sales connection',
      revision: 2, position: 2, enabledModels: state.modelsSaved ? models : [],
      saved: fact, reachable: fact,
      modelAnswer: { ...fact, model: models[0], outcome: state.untested ? 'skipped' : 'pass' },
      status: 'ready' }], loadedAt: time,
      access: { grantsAvailable: true, reason: 'model_access_routes' } };
  }
  await route.fulfill(json(body));
}
async function capture(page, name, width) {
  await page.evaluate(fontsReady);
  assert.deepEqual(await page.evaluate(layoutProblems), []);
  await page.screenshot({ path: resolve(output, `${name}-${width}.png`), fullPage: true });
}
async function fontsReady() { await document.fonts.ready; }
function layoutProblems() {
  const problems = [];
  if (document.documentElement.scrollWidth > window.innerWidth) problems.push('overflow');
  for (const target of document.querySelectorAll('dialog[open] button')) {
    const bounds = target.getBoundingClientRect();
    if (bounds.width && (bounds.width < 44 || bounds.height < 44)) problems.push('small target');
  }
  return problems;
}
async function captureSetup(browser, width, untested) {
  const state = { posts: new Map(), untested };
  const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
  async function serveRequest(route) { await serve(route, state); }
  await page.route(`${origin}/**`, serveRequest);
  await page.goto(`${origin}/org/models`);
  await page.locator('.provider-row-main').click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Next', exact: true }).click();
  await dialog.locator('.model-choice input').nth(0).check();
  await dialog.locator('.model-choice input').nth(1).check();
  await dialog.getByRole('button', { name: 'Next', exact: true }).click();
  const editors = dialog.locator('oc-provider-setup-access oc-model-access-editor');
  await editors.nth(1).getByText('Sales team', { exact: false }).waitFor();
  if (!untested) await capture(page, 'MOD-20', width);
  for (let index = 0; index < 2; index += 1) {
    const editor = editors.nth(index);
    await editor.getByRole('button', { name: 'Assistant', exact: true }).click();
    await editor.getByRole('button', { name: 'Grant', exact: true }).click();
    await editor.getByRole('button', { name: 'Save access', exact: true }).click();
    await editor.getByText(index === 0 ? 'Saved' : 'Outcome unknown', { exact: true }).waitFor();
  }
  if (!untested) await capture(page, 'MOD-20-partial', width);
  await dialog.getByRole('button', { name: 'Next', exact: true }).click();
  await dialog.locator('.completion').waitFor();
  assert.equal(state.posts.size, 2);
  await capture(page, untested ? 'MOD-21-untested' : 'MOD-21', width);
  await page.close();
}
await mkdir(output, { recursive: true });
const browser = await chromium.launch();
try {
  for (const width of [1280, 390]) {
    await captureSetup(browser, width, false);
    await captureSetup(browser, width, true);
  }
} finally {
  await browser.close();
}
process.stdout.write('PASS setup access captures and layout checks\n');
