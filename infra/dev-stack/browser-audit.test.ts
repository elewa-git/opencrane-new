import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { test } from 'node:test';
import { request } from 'playwright';
import { assertAuditMoney, assertPublishedAudit } from './browser-audit.ts';
import type { AuditRow } from '@opencrane/protocol';

async function checksAdminMoney() {
  const memberRow: AuditRow = { id: 'call', requestId: 'request', permitId: 'permit',
    requesterId: 'member', conversationId: 'conversation', turnId: 'turn',
    decision: 'allow', outcome: 'success', records: [] };
  const adminRow = { ...memberRow, reservedCents: 17, settledCents: 1 };
  const cases: Array<{ row: AuditRow; passes: boolean; privateText?: string }> = [
    { row: adminRow, passes: true },
    { row: { ...adminRow, reservedCents: 0, settledCents: 0 }, passes: true },
    { row: memberRow, passes: false },
    { row: { ...adminRow, settledCents: 0.5 }, passes: false },
    { row: { ...adminRow, requestId: 'another-request' }, passes: false },
    { row: { ...adminRow, permitId: 'another-permit' }, passes: false },
    { row: { ...adminRow, requesterId: 'another-member' }, passes: false },
    { row: { ...adminRow, conversationId: 'another-conversation' }, passes: false },
    { row: { ...adminRow, turnId: 'another-turn' }, passes: false },
    { row: adminRow, passes: false, privateText: 'private-canary' },
  ];
  let current = cases[0]!;
  function handle(incoming: import('node:http').IncomingMessage,
    response: import('node:http').ServerResponse) {
    incoming.resume();
    assert.equal(incoming.url, '/api/org/history?requestId=request');
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ rows: [current.row], privateText: current.privateText }));
  }
  const server = createServer(handle);
  const origin = await listen(server);
  const client = await request.newContext();
  const owner = { request: client };
  try {
    for (const example of cases) {
      current = example;
      async function check() {
        await assertAuditMoney(owner, origin, memberRow);
      }
      if (example.passes) await check();
      else await assert.rejects(check);
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
