import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import files from 'node:fs/promises';
import { test } from 'node:test';
import { request, type Page } from 'playwright';
import type { EventStore } from '@opencrane/event-store';
import { envelope } from '@opencrane/models';
import { browserBudgetJourney, restoreBudgetCeilings } from './browser-budgets.ts';
import { prepareBudgetAssistant } from './budget-fixture.ts';

async function restoresChosenScopes() {
  const totals = { todayCents: 0, monthCents: 0, reservedCents: 0, ceilingCents: 0 };
  const budget = { ...totals, sequence: 3, defaultPayingGroupId: 'installation-default',
    periodStart: null, dailyCeilingCents: 0, ceilings: [
      { ...totals, scope: 'paying_group', scopeId: 'sales' },
      { ...totals, scope: 'assistant', scopeId: 'team-sales' },
    ] };
  const restored: string[] = [];
  async function handle(incoming: import('node:http').IncomingMessage,
    response: import('node:http').ServerResponse) {
    response.setHeader('content-type', 'application/json');
    if (incoming.method === 'POST') {
      let contents = '';
      for await (const chunk of incoming) contents += String(chunk);
      const command = JSON.parse(contents) as { scope: string; scopeId?: string;
        expectedSequence: number; ceilingCents: number; dailyCeilingCents?: number };
      assert.equal(command.expectedSequence, budget.sequence);
      assert.equal(incoming.headers.origin, origin);
      if (command.scope === 'global') {
        budget.ceilingCents = command.ceilingCents;
        budget.dailyCeilingCents = command.dailyCeilingCents!;
      } else {
        function matchesScope(row: typeof budget.ceilings[number]) {
          return row.scope === command.scope && row.scopeId === command.scopeId;
        }
        const ceiling = budget.ceilings.find(matchesScope);
        if (!ceiling) {
          response.writeHead(422);
          response.end(JSON.stringify({ status: 'refused', reason: 'spending_choice_unavailable' }));
          return;
        }
        ceiling.ceilingCents = command.ceilingCents;
      }
      restored.push(command.scope);
      budget.sequence++;
    }
    response.end(JSON.stringify({ budget }));
  }
  const server = createServer(handle);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const client = await request.newContext();
  const owner = { request: client } as Page;
  async function head() {
    return budget.sequence;
  }
  const store = { head } as EventStore;
  try {
    await restoreBudgetCeilings(owner, origin, store, 'test', 'team-sales', 'sales');
    assert.deepEqual(restored, ['paying_group', 'assistant', 'global']);
    for (const ceiling of budget.ceilings) assert.equal(ceiling.ceilingCents, 20000);
    assert.equal(budget.ceilingCents, 20000);
    assert.equal(budget.dailyCeilingCents, 5000);
    assert.equal(budget.defaultPayingGroupId, 'installation-default');
  } finally {
    await client.dispose();
    server.closeAllConnections();
    const closed = once(server, 'close');
    server.close();
    await closed;
  }
}
test('restores every changed ceiling using the chosen group, not the personal default',
  restoresChosenScopes);

async function waitsForSharedAccess() {
  const receipts = new Map<string, number>();
  let sessions = 0;
  function handle(incoming: import('node:http').IncomingMessage,
    response: import('node:http').ServerResponse) {
    incoming.resume();
    response.setHeader('content-type', 'application/json');
    const path = incoming.url!;
    if (path.includes('/changes/')) {
      const reads = (receipts.get(path) ?? 0) + 1;
      receipts.set(path, reads);
      const iam = reads >= 2 ? 'current' : 'applying';
      response.end(JSON.stringify({ projection: { content: 'current', iam } }));
      return;
    }
    if (path === '/api/assistants/team-budget-journey') {
      const membership = receipts.get('/api/groups/budget-journey/changes/budget-journey-member');
      const assistant = receipts.get(
        '/api/assistants/team-budget-journey/changes/budget-journey-assistant');
      if ((membership ?? 0) < 2 || (assistant ?? 0) < 2) {
        response.writeHead(503);
        response.end(JSON.stringify({ status: 'unavailable' }));
        return;
      }
      const row = { assistantId: 'team-budget-journey', status: 'ready', canStartSession: true };
      response.end(JSON.stringify({ rows: [row] }));
      return;
    }
    if (path === '/api/conversations') sessions++;
    response.end(JSON.stringify({ status: 'appended' }));
  }
  const server = createServer(handle);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const client = await request.newContext();
  async function goto(url: string) {
    assert(new URL(url).searchParams.has('conversation'));
  }
  async function waitFor() {}
  function getByRole() {
    return { waitFor };
  }
  const page = { request: client, goto, getByRole } as unknown as Page;
  try {
    const chosen = await prepareBudgetAssistant(page, [page, page], origin, 'member');
    assert.deepEqual(chosen, { groupId: 'budget-journey', assistantId: 'team-budget-journey' });
    assert.equal(sessions, 2);
  } finally {
    await client.dispose();
    server.closeAllConnections();
    const closed = once(server, 'close');
    server.close();
    await closed;
  }
}
test('waits for saved membership and assistant access before opening both budget sessions',
  waitsForSharedAccess);

async function refusesPersonalAssistant() {
  const data = { assistantId: 'personal-alice', ownerId: 'alice', kind: 'personal',
    payingGroupId: 'installation-default' };
  const event = envelope('test', 'assistant-personal-alice', 'assistant.created', data);
  async function* readStream(subject: string) {
    assert.equal(subject, 'assistant-personal-alice');
    yield { event, sequence: 1 };
  }
  const store = { readStream } as EventStore;
  const owner = {} as Page;
  const journey = browserBudgetJourney(owner, [], 'http://localhost', store, 'test',
    'personal-alice', 'sales');
  const refusal = { name: 'AssertionError',
    message: 'Budget notices must use a shared assistant that the owner can choose in Spending' };
  await assert.rejects(journey, refusal);
}
test('refuses a personal assistant before starting the budget browser journey',
  refusesPersonalAssistant);

async function retainsEditorLoadFailure(statusCode = 503, failScreenshot = false) {
  const fixture = await files.mkdtemp(`${import.meta.dirname}/.budget-load-`);
  const fixtureSource = `${fixture}/browser-budgets.ts`;
  const source = new URL('./browser-budgets.ts', import.meta.url);
  await files.copyFile(source, fixtureSource);
  const configuration = `export const directory = ${JSON.stringify(fixture)};\n`
    + `export const root = ${JSON.stringify(fixture)};\n`;
  await files.writeFile(`${fixture}/config.ts`, configuration);
  for (const width of [1280, 390]) {
    await files.writeFile(`${fixture}/workspace-${width}.png`, 'Synthetic screenshot');
  }
  const isolated = await import(fixtureSource) as typeof import('./browser-budgets.ts');
  const screenshots: string[] = [];
  const listeners = new Set<(response: unknown) => void>();
  let failedWaits = 0;
  let navigations = 0;
  const totals = { todayCents: 0, monthCents: 0, reservedCents: 0, ceilingCents: 20000 };
  const budget = { ...totals, sequence: 1, defaultPayingGroupId: 'installation-default',
    periodStart: null, dailyCeilingCents: 5000, ceilings: [] };
  const assistantData = { assistantId: 'team-sales', ownerId: 'sales', kind: 'team',
    payingGroupId: 'sales' };
  const assistant = envelope('test', 'assistant-team-sales', 'assistant.created', assistantData);
  const ceilingData = { scope: 'global', ceilingCents: 20000, dailyCeilingCents: 5000,
    defaultPayingGroupId: 'installation-default', setBy: 'installation' };
  const ceiling = envelope('test', 'budget-test', 'budget.ceiling_set', ceilingData);
  async function* readStream(subject: string) {
    const event = subject === 'budget-test' ? ceiling : assistant;
    yield { event, sequence: 1 };
  }
  function on(_name: string, listener: (response: unknown) => void) {
    listeners.add(listener);
  }
  function off(_name: string, listener: (response: unknown) => void) {
    listeners.delete(listener);
  }
  async function goto() {
    navigations++;
    function url() {
      return 'http://fixture.test/api/org/models';
    }
    function status() {
      return statusCode;
    }
    function method() {
      return 'GET';
    }
    function requestDetails() {
      return { method };
    }
    for (const listener of listeners) {
      listener({ url, status, request: requestDetails });
    }
  }
  async function ready() {}
  function getByText() {
    return { waitFor: ready };
  }
  async function missingEditor() {
    failedWaits++;
    throw new Error('Synthetic driver detail that must stay out of the receipt');
  }
  function getByLabel(name: string) {
    assert.equal(name, 'Budget scope');
    return { waitFor: missingEditor };
  }
  async function screenshot(options: { path: string }) {
    screenshots.push(options.path);
    if (failScreenshot) throw new Error('Synthetic screenshot failure');
  }
  async function get() {
    function status() {
      return 200;
    }
    async function json() {
      return { budget };
    }
    return { status, json };
  }
  const requestDetails = { get };
  const owner = { goto, getByText, getByLabel, screenshot, on, off, setViewportSize: ready,
    request: requestDetails } as unknown as Page;
  const store = { readStream } as EventStore;
  try {
    function viewportSize() {
      return { width: 1280, height: 900 };
    }
    const member = { viewportSize } as Page;
    const journey = isolated.browserBudgetJourney(owner, [member], 'http://fixture.test', store,
      'test', 'team-sales', 'sales');
    let failure: unknown;
    try {
      await journey;
    } catch (error) {
      failure = error;
    }
    assert(failure instanceof Error);
    assert.equal(failedWaits, 1);
    assert.equal(navigations, 2, 'A failed read never resubmits a save or reloads the page');
    const contents = await files.readFile(`${fixture}/budget-editor-failure.log`, 'utf8');
    const expected = { budgetReadStatuses: [statusCode], effectReadStatuses: [] };
    assert.deepEqual(JSON.parse(contents), expected);
    assert.equal(screenshots.length, 1);
    assert(screenshots[0]!.endsWith('/budget-editor-failure.png'));
    assert.equal(listeners.size, 0, 'Remove response listeners after the failed load');
    assert.equal(failure.message, 'Spending budget editor did not load; inspect private evidence');
  } finally {
    await files.rm(fixture, { recursive: true, force: true });
  }
}

async function retainsUnavailableRead() {
  await retainsEditorLoadFailure();
}
test('keeps the actual failed budget load and a screenshot without copying driver errors',
  retainsUnavailableRead);

async function retainsRefusedRead() {
  await retainsEditorLoadFailure(403);
}
test('records an access refusal and fails without refreshing or resubmitting a save',
  retainsRefusedRead);

async function keepsReadWhenScreenshotFails() {
  await retainsEditorLoadFailure(200, true);
}
test('keeps a successful HTTP read when rendering and screenshot capture fail',
  keepsReadWhenScreenshotFails);
