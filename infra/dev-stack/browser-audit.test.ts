import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { test } from 'node:test';
import { request, type Page } from 'playwright';
import { assertAuditMoney, assertPublishedAudit, readSuccessfulTurnAudit } from './browser-audit.ts';
import type { AuditRow } from '@opencrane/protocol';

async function checksAdminMoney() {
  const memberRow: AuditRow = { id: 'call', requestId: 'request', permitId: 'permit',
    requesterId: 'member', conversationId: 'conversation', turnId: 'turn',
    decision: 'allow', outcome: 'success', records: [] };
  const adminRow = { ...memberRow, reservedCents: 17, settledCents: 1 };
  const cases: Array<{ row: AuditRow; passes: boolean; additionalRow?: AuditRow }> = [
    { row: adminRow, passes: true },
    { row: { ...adminRow, reservedCents: 0, settledCents: 0 }, passes: true },
    { row: memberRow, passes: false },
    { row: { ...memberRow, settledCents: 1 }, passes: false },
    { row: { ...memberRow, reservedCents: 17 }, passes: false },
    { row: { ...adminRow, reservedCents: 16.5 }, passes: false },
    { row: { ...adminRow, settledCents: 0.5 }, passes: false },
    { row: { ...adminRow, requestId: 'another-request' }, passes: false },
    { row: { ...adminRow, permitId: 'another-permit' }, passes: false },
    { row: { ...adminRow, requesterId: 'another-member' }, passes: false },
    { row: { ...adminRow, conversationId: 'another-conversation' }, passes: false },
    { row: { ...adminRow, turnId: 'another-turn' }, passes: false },
    { row: adminRow, passes: false, additionalRow: { ...adminRow, id: 'private-canary' } },
  ];
  let current = cases[0]!;
  function handle(incoming: import('node:http').IncomingMessage,
    response: import('node:http').ServerResponse) {
    incoming.resume();
    assert.equal(incoming.url, '/api/org/history?requestId=request');
    response.setHeader('content-type', 'application/json');
    const rows = current.additionalRow ? [current.row, current.additionalRow] : [current.row];
    response.end(JSON.stringify({ rows }));
  }
  const server = createServer(handle);
  const origin = await listen(server);
  const client = await request.newContext();
  const owner = { request: client };
  try {
    for (const example of cases) {
      current = example;
      async function check() {
        return assertAuditMoney(owner, origin, memberRow);
      }
      if (example.passes) {
        const amounts = await check();
        assert.deepEqual(amounts, {
          reservedCents: example.row.reservedCents, chargedCents: example.row.settledCents,
        });
      } else await assert.rejects(check);
    }
  } finally {
    await client.dispose();
    await closeServer(server);
  }
}
void test('checks the same call’s integer money amounts only in admin Change history', checksAdminMoney);

async function readsOlderPublication() {
  for (const published of [true, false]) {
    const paths: string[] = [];
    function handle(incoming: import('node:http').IncomingMessage,
      response: import('node:http').ServerResponse) {
      incoming.resume();
      paths.push(incoming.url!);
      const older = incoming.url === '/api/org/history?before=311';
      let type = 'grant.given';
      if (older && published) type = 'mcp.server_published';
      const record = { eventId: 'event', type, position: older ? 303 : 311,
        source: 'authoritative', status: 'recorded' };
      const row = { id: 'event', decision: 'not_recorded', outcome: 'recorded', records: [record] };
      const body = { rows: [row], ...(!older ? { nextBefore: 311 } : {}) };
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(body));
    }
    const server = createServer(handle);
    const origin = await listen(server);
    const client = await request.newContext();
    const owner = { request: client };
    async function check() {
      await assertPublishedAudit(owner, origin);
    }
    try {
      if (published) await check();
      else await assert.rejects(check, /Organisation history contains the saved MCP publication/);
      assert.deepEqual(paths, ['/api/org/history', '/api/org/history?before=311']);
    } finally {
      await client.dispose();
      await closeServer(server);
    }
  }
}
void test('finds a publication behind newer grants and still refuses a missing publication',
  readsOlderPublication);

async function listen(server: Server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server) {
  server.closeAllConnections();
  const closed = once(server, 'close');
  server.close();
  await closed;
}

async function checksMemberMoneyPrivacy() {
  const prompt = 'Fixture member turn';
  const message = { id: 'turn', position: 1, type: 'message.posted', time: 'now',
    data: { text: prompt } };
  const feed = { rows: [message], position: 1, generation: 1, computerState: 'ready' };
  const memberRow: AuditRow = { id: 'call', requestId: 'request', permitId: 'permit',
    requesterId: 'member', conversationId: 'conversation', turnId: 'turn',
    contextDigest: 'a'.repeat(64), decision: 'allow', outcome: 'success', records: [] };
  let history = { rows: [memberRow] };
  function handle(incoming: import('node:http').IncomingMessage,
    response: import('node:http').ServerResponse): void {
    incoming.resume();
    response.setHeader('content-type', 'application/json');
    const body = incoming.url?.endsWith('/messages') ? feed : history;
    response.end(JSON.stringify(body));
  }
  const server = createServer(handle);
  const origin = await listen(server);
  const client = await request.newContext();
  function workspaceUrl(): string {
    return `${origin}/workspace?conversation=conversation`;
  }
  const page: Pick<Page, 'request' | 'url'> = { request: client, url: workspaceUrl };
  const readTurn = readSuccessfulTurnAudit.bind(undefined, page as Page, origin, prompt);
  try {
    const visible = await readTurn();
    assert.equal(visible.row.id, memberRow.id);
    history = { rows: [{ ...memberRow, reservedCents: 16 }] };
    await assert.rejects(readTurn(), /Member action history does not expose money amounts/u);
    history = { rows: [{ ...memberRow, settledCents: 1 }] };
    await assert.rejects(readTurn(), /Member action history does not expose money amounts/u);
  } finally {
    await client.dispose();
    await closeServer(server);
  }
}

void test('the turn read used by the packaged journey refuses either member money field',
  checksMemberMoneyPrivacy);
