import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { before, test } from 'node:test';
import { promisify } from 'node:util';
import { chromium, type Page, type Route } from 'playwright';
import { budgetCommandSchema, type BudgetSummary } from '@opencrane/protocol';
import { loadBudgetEditor } from './browser-budgets.ts';

const root = resolve(import.meta.dirname, '../..');
const build = resolve(root, 'apps/web/dist/web/browser');
const origin = 'https://budget-editor.opencrane.test';
const run = promisify(execFile);
const assetTypes: Record<string, string> = {
  js: 'text/javascript', css: 'text/css', woff2: 'font/woff2', svg: 'image/svg+xml',
};

async function buildWebsite() {
  const cli = resolve(root, 'node_modules/@angular/cli/bin/ng.js');
  await run(process.execPath, [cli, 'build', '--configuration', 'development'], {
    cwd: resolve(root, 'apps/web'), timeout: 180_000, maxBuffer: 8 * 1024 * 1024,
  });
}
before(buildWebsite, { timeout: 190_000 });

function reply(status: number, body: unknown) {
  return { status, contentType: 'application/json', body: JSON.stringify(body) };
}

function newBudget(): BudgetSummary {
  return {
    sequence: 1, defaultPayingGroupId: 'sales', periodStart: null,
    todayCents: 0, monthCents: 0, reservedCents: 0, ceilingCents: 20000,
    dailyCeilingCents: 5000, ceilings: [],
  };
}

async function serveAsset(route: Route) {
  const pathname = new URL(route.request().url()).pathname;
  const pathParts = pathname.split('.');
  const extension = pathParts.at(-1) ?? '';
  const contentType = assetTypes[extension];
  const filename = contentType ? pathname.slice(1) : 'index.html';
  const body = await readFile(resolve(build, filename));
  await route.fulfill({ body, contentType: contentType ?? 'text/html' });
}

async function saveBudget(page: Page, directory: string, scope: 'global' | 'paying_group'
  | 'assistant', cents: number) {
  const selector = await loadBudgetEditor(page, origin, directory);
  await selector.selectOption(scope);
  if (scope !== 'global') {
    const label = scope === 'assistant' ? 'Assistant id' : 'Paying group id';
    const scopeId = scope === 'assistant' ? 'team-sales' : 'sales';
    await page.getByLabel(label, { exact: true }).fill(scopeId);
  }
  await page.getByLabel('Monthly ceiling (euro cents)', { exact: true }).fill(String(cents));
  await page.getByRole('button', { name: 'Save budget', exact: true }).click();
  await page.getByText('Budget saved', { exact: true }).waitFor();
}

type BudgetCommand = ReturnType<typeof budgetCommandSchema.parse>;

function applyCommand(budget: BudgetSummary, command: BudgetCommand) {
  if (command.scope === 'global') {
    budget.ceilingCents = command.ceilingCents;
    budget.dailyCeilingCents = command.dailyCeilingCents ?? budget.dailyCeilingCents;
    budget.defaultPayingGroupId = command.defaultPayingGroupId ?? budget.defaultPayingGroupId;
  } else {
    const scope = command.scope;
    const scopeId = command.scopeId;
    function matchesScope(ceiling: BudgetSummary['ceilings'][number]) {
      return ceiling.scope === scope && ceiling.scopeId === scopeId;
    }
    const ceiling = budget.ceilings.find(matchesScope);
    if (ceiling) {
      ceiling.ceilingCents = command.ceilingCents;
    } else {
      const newCeiling = { scope: command.scope, scopeId: command.scopeId,
        ceilingCents: command.ceilingCents, todayCents: 0, monthCents: 0, reservedCents: 0 };
      budget.ceilings.push(newCeiling);
    }
  }
}

function budgetFixture() {
  const budget = newBudget();
  const counts = { writes: 0, reads: 0 };
  async function intercept(route: Route) {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname === '/api/org/effects') {
      await route.fulfill(reply(200, { effects: [] }));
      return;
    }
    if (pathname !== '/api/org/models') {
      await serveAsset(route);
      return;
    }
    if (request.method() !== 'POST') {
      counts.reads += 1;
      await route.fulfill(reply(200, { budget }));
      return;
    }
    const body: unknown = request.postDataJSON();
    const command = budgetCommandSchema.parse(body);
    assert.equal(command.expectedSequence, budget.sequence);
    counts.writes += 1;
    if (command.scope !== 'global' && command.scopeId === 'missing') {
      await route.fulfill(reply(422, {
        status: 'refused', reason: 'spending_choice_unavailable',
      }));
      return;
    }
    applyCommand(budget, command);
    budget.sequence += 1;
    await route.fulfill(reply(200, { budget }));
  }
  return { intercept, counts };
}

async function repeatedSavesAndCorrection() {
  const directory = await mkdtemp(resolve(tmpdir(), 'budget-editor-'));
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.setDefaultTimeout(10_000);
  const fixture = budgetFixture();
  await page.route(`${origin}/**`, fixture.intercept);
  try {
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      const selector = await loadBudgetEditor(page, origin, directory);
      await selector.selectOption('paying_group');
      await page.getByLabel('Paying group id', { exact: true }).fill('missing');
      await page.getByLabel('Monthly ceiling (euro cents)', { exact: true }).fill('0');
      await page.getByRole('button', { name: 'Save budget', exact: true }).click();
      const refusal = page.getByText('This spending choice is unavailable. '
        + 'Choose another group or active shared assistant.', { exact: true });
      await refusal.waitFor();
      await page.getByLabel('Paying group id', { exact: true }).fill('sales');
      await page.getByRole('button', { name: 'Save budget', exact: true }).click();
      await page.getByText('Budget saved', { exact: true }).waitFor();
      for (const scope of ['paying_group', 'assistant'] as const) {
        await saveBudget(page, directory, 'paying_group', 20000);
        await saveBudget(page, directory, 'assistant', 20000);
        await saveBudget(page, directory, scope, 0);
      }
    }
    await saveBudget(page, directory, 'paying_group', 20000);
    await saveBudget(page, directory, 'assistant', 20000);
    await saveBudget(page, directory, 'global', 20000);
    assert.equal(fixture.counts.writes, 19);
    assert.equal(fixture.counts.reads, 17);
  } finally {
    await browser.close();
    await rm(directory, { recursive: true, force: true });
  }
}
test('loads the real editor after refused saves and repeated saves at both widths',
  { timeout: 120_000 }, repeatedSavesAndCorrection);

async function capturesTransportFailure() {
  const directory = await mkdtemp(resolve(tmpdir(), 'budget-editor-failure-'));
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.setDefaultTimeout(10_000);
  let failedReads = 0;
  async function intercept(route: Route) {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/api/org/models' || pathname === '/api/org/effects') {
      failedReads += 1;
      await route.abort('connectionreset');
      return;
    }
    await serveAsset(route);
  }
  await page.route(`${origin}/**`, intercept);
  try {
    async function load() {
      await loadBudgetEditor(page, origin, directory);
    }
    await assert.rejects(load, /Spending budget editor did not load/);
    const details = await readFile(`${directory}/budget-editor-failure.log`, 'utf8');
    assert.deepEqual(JSON.parse(details), {
      budgetReadStatuses: [], effectReadStatuses: [],
      editorState: { budgetScopeVisible: false, budgetServiceUnavailable: true,
        accessChanged: false, spendingLoaded: false },
    });
    const picturePath = `${directory}/budget-editor-failure.png`;
    const picture = await readFile(picturePath);
    const signature = picture.subarray(0, 8);
    assert.equal(signature.toString('hex'), '89504e470d0a1a0a');
    assert.equal((await stat(picturePath)).mode & 0o777, 0o600);
    assert.equal(failedReads, 2, 'Do not retry either failed read');
  } finally {
    await browser.close();
    await rm(directory, { recursive: true, force: true });
  }
}
test('keeps a private page picture when both API reads receive no HTTP response',
  { timeout: 30_000 }, capturesTransportFailure);
