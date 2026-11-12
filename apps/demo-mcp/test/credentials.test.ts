import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { createDemoServer } from '../src/server.ts';
import { discoverInventory } from '../../server/test/inventory.ts';

const accounts = [
  { account: 'Account A', key: randomUUID(), permitted: true },
  { account: 'Account B', key: randomUUID(), permitted: false },
] as const;
const server = createDemoServer(undefined, { accounts });
const version = '2026-07-28';
let revision = '';

async function request(method: string, name?: string, args?: unknown, key?: string) {
  const headers: Record<string, string> = {
    'mcp-protocol-version': version, 'mcp-method': method,
    'mcp-name': name ?? '', 'x-opencrane-mcp-revision': revision,
  };
  if (key) headers['authorization'] = `Bearer ${key}`;
  const params = { _meta: { 'io.modelcontextprotocol/protocolVersion': version },
    name, arguments: args };
  const response = await server.inject({ method: 'POST', url: '/', headers,
    payload: { jsonrpc: '2.0', id: 'request', method, params } });
  return response.json<{
    result?: { isError: boolean; structuredContent: Record<string, unknown> };
    error?: { message: string };
  }>();
}
async function inventory(method: 'server/discover' | 'tools/list') {
  const response = await request(method);
  return JSON.stringify(response.result);
}
async function prepare() {
  const discovered = await discoverInventory(inventory);
  revision = discovered.schemaDigest;
}
async function close() {
  await server.close();
}
afterEach(close);

async function actWithOwnRights() {
  await prepare();
  for (const account of accounts) {
    const identity = await request('tools/call', 'who_am_i', {}, account.key);
    expect(identity.result).toMatchObject({ isError: false,
      structuredContent: { subject: account.account, actedAs: account.account } });
    for (const name of ['read_fixture_quote', 'change_delivery_slot']) {
      const args = name === 'read_fixture_quote' ? { quoteId: 'DEMO-001' }
        : { quoteId: 'DEMO-001', slot: 'afternoon' };
      const response = await request('tools/call', name, args, account.key);
      expect(response.result).toMatchObject({ isError: !account.permitted,
        structuredContent: { actedAs: account.account } });
      if (!account.permitted) {
        expect(response.result?.structuredContent['reason']).toBe('not_permitted');
      }
    }
  }
  const missing = await request('tools/call', 'who_am_i', {});
  expect(missing.error?.message).toBe('invalid_request');
  const unknown = await request('tools/call', 'who_am_i', {}, randomUUID());
  expect(unknown.error?.message).toBe('invalid_request');
  const override = await request('tools/call', 'read_fixture_quote', {
    quoteId: 'DEMO-001', account: 'Account A',
  }, accounts[1].key);
  expect(override.error?.message).toBe('invalid_request');
}
it('checks identity and applies only the rights of the supplied key', actWithOwnRights);
