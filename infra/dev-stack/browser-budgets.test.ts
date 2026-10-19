import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
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
