import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { createDemoServer } from '../../apps/demo-mcp/src/server.ts';
import { recordDemoCalls } from './record-demo-calls.ts';

async function recordsExactRequestBytes() {
  const directory = await mkdtemp(`${tmpdir()}/demo-recording-`);
  const demo = createDemoServer();
  const file = `${directory}/calls.jsonl`;
  recordDemoCalls(demo, file);
  const body = '{ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {} }';
  const headers = { 'content-type': 'application/json',
    'mcp-name': 'change_delivery_slot', 'x-request-id': 'recorded-request' };
  try {
    await demo.inject({ method: 'POST', url: '/', headers, payload: body });
    await demo.inject({ method: 'POST', url: '/',
      headers: { ...headers, 'mcp-name': 'read_fixture_quote' }, payload: body });
    const text = await readFile(file, 'utf8');
    const rows = text.trim().split('\n');
    assert.equal(rows.length, 1);
    assert.deepEqual(JSON.parse(rows[0]!), { body, requestId: 'recorded-request' });
  } finally {
    await demo.close();
    await rm(directory, { recursive: true, force: true });
  }
}
test('the demo recorder keeps exact write bytes and ignores readback calls',
  recordsExactRequestBytes);
