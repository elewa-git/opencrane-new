/* global document, window */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { chromium } from 'playwright';

const output = resolve('docs/process/screen-p4-22-tables');
const build = resolve('apps/web/dist/web/browser');
const origin = 'https://model-tables.opencrane.test';
const time = '2026-10-14T09:00:00Z';
const model = 'gpt-6.1-sol';
const empty = { status: 'not_available_yet' };
const grant = { granteeKind: 'team', granteeId: 'sales', displayName: 'Sales',
  source: 'group', state: 'granted', eventId: 'grant-one', eventTime: time,
  sequence: 4, projection: 'current' };
const access = { modelId: model, expectedSequence: 4, loadedAt: time, canManage: true,
  grants: [grant], grantTotal: 1, explanations: { configuredUses: empty },
  availability: { registrySupported: true, selectedConnection: empty, enabledModel: empty,
    connection: empty, key: empty, verification: empty },
  projection: { content: 'current', sequence: 4 } };
const provider = { providerId: 'first', provider: 'openai', name: 'Primary', revision: 2,
  position: 2, enabledModels: [model], status: 'saved_unverified',
  saved: { changeId: 'saved-one', time, revision: 2, outcome: 'recorded' } };
const binding = { kind: 'assistant', dependantId: 'helper', task: 'chat_turn',
  state: 'active', model, assistantCount: 1 };

function json(body, status = 200) {
  return { status, contentType: 'application/json', body: JSON.stringify(body) };
}

async function serve(route, state) {
  const request = route.request();
  const path = new URL(request.url()).pathname;
  if (!path.startsWith('/api/')) {
    let file = resolve(build, `.${path}`);
    if (!extname(file)) file = resolve(build, 'index.html');
    assert.ok(file.startsWith(`${build}/`));
    const contentType = { '.html': 'text/html', '.js': 'text/javascript',
      '.css': 'text/css', '.woff2': 'font/woff2' }[extname(file)];
    await route.fulfill({ body: await readFile(file), contentType });
    return;
  }
  state.requests.push({ path, method: request.method() });
  assert.equal(request.method(), 'GET');
  let reply;
  if (path === '/api/org/providers') {
    reply = state.failed ? json({}, 503) : json({ rows: state.empty ? [] : [provider],
      loadedAt: time, access: { grantsAvailable: true, reason: 'model_access_routes' } });
  } else if (path === '/api/org/models') {
    reply = json({ models: [{ id: model }, { id: 'gpt-6-astra' }],
      taskRouting: { chat_turn: { model, reason: 'Chat' } } });
  } else if (path === '/api/assistants') {
    reply = json({ rows: [{ assistantId: 'helper', name: 'Helper' }] });
  } else if (path.endsWith('/bindings')) {
    reply = json({ rows: [binding] });
  } else if (path.endsWith('/access')) {
    reply = json(access);
  } else {
    throw new Error(`Unexpected request: ${path}`);
  }
  if (state.forbidden && path === '/api/org/providers') reply = json({}, 403);
  await route.fulfill(reply);
}

async function open(browser, width, state) {
  const page = await browser.newPage({ viewport: { width, height: 900 },
    reducedMotion: state.reducedMotion ? 'reduce' : 'no-preference' });
  page.setDefaultTimeout(10000);
  async function serveRequest(route) { await serve(route, state); }
  await page.route(`${origin}/**`, serveRequest);
  await page.goto(`${origin}/org/models`);
  return page;
}

async function layoutProblems() {
  await document.fonts.ready;
  const problems = [];
  if (document.documentElement.scrollWidth > window.innerWidth) problems.push('overflow');
  for (const button of document.querySelectorAll('button')) {
    const box = button.getBoundingClientRect();
    if (box.width && box.height && (box.width < 44 || box.height < 44)) {
      problems.push(`small button: ${button.textContent?.trim()}`);
    }
  }
  return problems;
}

async function capture(page, name, width) {
  const problems = await page.evaluate(layoutProblems);
  assert.deepEqual(problems, [], `${name} at ${width}px`);
  await page.screenshot({ path: resolve(output, `${name}-${width}.png`), fullPage: true });
}

async function cases(browser, width) {
  let state = { empty: true, requests: [] };
  let page = await open(browser, width, state);
  await page.getByText('No usable models').waitFor();
  await capture(page, 'MOD-01', width);
  await page.close();

  state = { requests: [] };
  page = await open(browser, width, state);
  await page.getByText('not usable by Helper').waitFor();
  await capture(page, 'MOD-02', width);
  state.failed = true;
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.getByText('Showing the last data loaded at').waitFor();
  await capture(page, 'MOD-03', width);
  await page.close();

  state = { requests: [], forbidden: true };
  page = await open(browser, width, state);
  await page.getByText('Owner or Admin role required').waitFor();
  await capture(page, 'MOD-04', width);
  await page.close();

  state = { requests: [], reducedMotion: true };
  page = await open(browser, width, state);
  await page.getByText('not usable by Helper').waitFor();
  await capture(page, 'MOD-02-RM', width);
  if (width === 390) {
    await page.getByRole('button', { name: 'Open organisation navigation' }).click();
  }
  await capture(page, 'MOD-06', width);
  await page.close();
}

await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  await cases(browser, 1280);
  await cases(browser, 390);
} finally {
  await browser.close();
}
const receipt = `# Models table screen captures

PASS: Intercepted GET replies produced all six states at 1280px and 390px.
PASS: No captured page has horizontal overflow. Visible buttons measure at least 44px.

| Frame | Difference from the supplied design |
| --- | --- |
| MOD-01 | The provider and model empty messages are separate. The page does not say that nobody has a grant. |
| MOD-02 | Names, grants and counts come from fixture replies. The model says Enabled; the provider keeps its separate saved and verification facts. |
| MOD-02-RM | The data matches MOD-02. The browser uses reduced motion. |
| MOD-03 | The dated rows remain after a failed refresh. Provider actions are disabled. |
| MOD-04 | The current server role refusal replaces the proposed read-only view. |
| MOD-06 | The phone uses the existing organisation menu. Desktop keeps its sidebar. |

The pictures use intercepted replies. A fresh-install provider journey is NOT RUN.
`;
await writeFile(resolve(output, 'receipt.md'), receipt);
