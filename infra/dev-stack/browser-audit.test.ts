import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { request, type Page } from 'playwright';
import { assertPublishedAudit } from './browser-audit.ts';

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
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    const client = await request.newContext();
    const owner = { request: client } as Page;
    async function check() {
      await assertPublishedAudit(owner, origin);
    }
    try {
      if (published) await check();
      else await assert.rejects(check, /Organisation history contains the saved MCP publication/);
      assert.deepEqual(paths, ['/api/org/history', '/api/org/history?before=311']);
    } finally {
      await client.dispose();
      server.closeAllConnections();
      const closed = once(server, 'close');
      server.close();
      await closed;
    }
  }
}
test('finds a publication behind newer grants and still refuses a missing publication',
  readsOlderPublication);
