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

interface ReadResponse {
  method: string;
  url: string;
  status: number;
}

async function retainsEditorLoadFailure(statusCode = 503, failPageState = false,
  extraResponses: ReadResponse[] = [], effectReadStatuses: number[] = [], failCapture = false) {
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
  const screenshots: { fullPage: boolean }[] = [];
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
  function emitResponse(details: ReadResponse) {
    function url() {
      return details.url;
    }
    function status() {
      return details.status;
    }
    function method() {
      return details.method;
    }
    function requestDetails() {
      return { method };
    }
    const response = { url, status, request: requestDetails };
    for (const listener of listeners) {
      listener(response);
    }
  }
  async function goto() {
    navigations++;
    const budgetResponse = {
      method: 'GET', url: 'http://fixture.test/api/org/models', status: statusCode,
    };
    emitResponse(budgetResponse);
    for (const response of extraResponses) {
      emitResponse(response);
    }
  }
  async function ready() {}
  function getByText(name: string) {
    async function isVisible() {
      if (failPageState) {
        throw new Error('Synthetic private page detail');
      }
      if (name === 'Budget service unavailable') {
        return statusCode === 503;
      }
      if (name === 'Spending needs the Owner or Admin role.') {
        return statusCode === 403;
      }
      assert.equal(name, 'Spending loaded');
      return statusCode === 200;
    }
    return { waitFor: ready, isVisible };
  }
  async function missingEditor() {
    failedWaits++;
    throw new Error('Synthetic driver detail that must stay out of the receipt');
  }
  function getByLabel(name: string) {
    assert.equal(name, 'Budget scope');
    async function isVisible() {
      if (failPageState) {
        throw new Error('Synthetic private page detail');
      }
      return false;
    }
    return { waitFor: missingEditor, isVisible };
  }
  async function screenshot(options: { fullPage: boolean }) {
    screenshots.push(options);
    if (failCapture) {
      throw new Error('Synthetic private screenshot failure');
    }
    return Buffer.from('Synthetic screenshot');
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
    const editorState = {
      budgetScopeVisible: false,
      budgetServiceUnavailable: statusCode === 503,
      accessChanged: statusCode === 403,
      spendingLoaded: statusCode === 200,
    };
    const unreadableState = {
      budgetScopeVisible: null, budgetServiceUnavailable: null,
      accessChanged: null, spendingLoaded: null,
    };
    const expected = { budgetReadStatuses: [statusCode], effectReadStatuses,
      editorState: failPageState ? unreadableState : editorState };
    assert.deepEqual(JSON.parse(contents), expected);
    assert.deepEqual(screenshots, [{ fullPage: true }],
      'Keep the failed page before cleanup removes it');
    const picturePath = `${fixture}/budget-editor-failure.png`;
    if (failCapture) {
      await assert.rejects(files.stat(picturePath), { code: 'ENOENT' });
    } else {
      assert.equal(await files.readFile(picturePath, 'utf8'), 'Synthetic screenshot');
      assert.equal((await files.stat(picturePath)).mode & 0o777, 0o600);
    }
    assert.equal(contents.includes('Synthetic private page detail'), false);
    assert.equal(listeners.size, 0, 'Remove response listeners after the failed load');
    assert.equal(failure.message, 'Spending budget editor did not load; inspect private evidence');
  } finally {
    await files.rm(fixture, { recursive: true, force: true });
  }
}

async function retainsUnavailableRead() {
  await retainsEditorLoadFailure();
}
test('keeps failed budget read statuses, fixed page states and a private picture',
  retainsUnavailableRead);

async function retainsRefusedRead() {
  await retainsEditorLoadFailure(403);
}
test('records an access refusal and fails without refreshing or resubmitting a save',
  retainsRefusedRead);

async function keepsReadWhenPageStateFails() {
  await retainsEditorLoadFailure(200, true);
}
test('keeps HTTP statuses when the failed page cannot be inspected',
  keepsReadWhenPageStateFails);

async function excludesWriteResponses() {
  const writes = [
    { method: 'POST', url: 'http://fixture.test/api/org/models', status: 201 },
    { method: 'POST', url: 'http://fixture.test/api/org/effects', status: 202 },
  ];
  await retainsEditorLoadFailure(503, false, writes);
}
test('excludes non-GET responses from both status lists', excludesWriteResponses);

async function excludesOtherUrls() {
  const otherReads = [
    { method: 'GET', url: 'http://fixture.test/api/org/models/extra', status: 404 },
    { method: 'GET', url: 'http://fixture.test/api/org/models?token=synthetic', status: 401 },
    { method: 'GET', url: 'http://other.test/api/org/models', status: 502 },
    { method: 'GET', url: 'http://fixture.test/api/org/effects?person=synthetic', status: 403 },
  ];
  await retainsEditorLoadFailure(503, false, otherReads);
}
test('records only the exact budget and effects URLs on the chosen origin', excludesOtherUrls);

async function retainsEffectsResponses() {
  const effectReads = [
    { method: 'GET', url: 'http://fixture.test/api/org/effects', status: 200 },
    { method: 'GET', url: 'http://fixture.test/api/org/effects', status: 503 },
  ];
  await retainsEditorLoadFailure(503, false, effectReads, [200, 503]);
}
test('keeps effects GET statuses separately and in arrival order', retainsEffectsResponses);

async function keepsEvidenceWhenCaptureFails() {
  await retainsEditorLoadFailure(503, false, [], [], true);
}
test('keeps the original failure and HTTP evidence when taking its picture fails',
  keepsEvidenceWhenCaptureFails);
