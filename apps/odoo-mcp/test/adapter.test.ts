import { afterAll, beforeAll, expect, it } from 'vitest';
import { z } from 'zod';
import { createAdapter } from '../src/server.ts';

const version = '2026-07-28';
const adapter = createAdapter();
let endpoint: string;
const meta = { 'io.modelcontextprotocol/protocolVersion': version,
  'io.modelcontextprotocol/clientCapabilities': {} };

async function start() {
  endpoint = await adapter.listen({ host: '127.0.0.1', port: 0 });
}
async function stop() {
  await adapter.close();
}
beforeAll(start);
afterAll(stop);

async function rpc(method: string, params: Record<string, unknown> = {}, bearer?: string,
  headers: Record<string, string> = {}) {
  const body = { jsonrpc: '2.0', id: 'test', method, params: { _meta: meta, ...params } };
  const requestHeaders = { 'content-type': 'application/json', 'mcp-protocol-version': version,
    'mcp-method': method };
  if (method === 'tools/call') {
    Object.assign(requestHeaders, { 'mcp-name': params['name'] });
  }
  if (bearer) {
    Object.assign(requestHeaders, { authorization: `Bearer ${bearer}` });
  }
  Object.assign(requestHeaders, headers);
  const response = await fetch(endpoint, {
    method: 'POST', headers: requestHeaders, body: JSON.stringify(body),
  });
  expect(response.headers.get('mcp-session-id')).toBeNull();
  expect(response.headers.get('content-type')).toContain('application/json');
  const json: unknown = await response.json();
  return z.object({ jsonrpc: z.literal('2.0'), id: z.literal('test'),
    result: z.record(z.string(), z.unknown()).optional(),
    error: z.object({ code: z.number(), message: z.string() }).optional() }).parse(json);
}
function result(reply: Awaited<ReturnType<typeof rpc>>) {
  expect(reply.error).toBeUndefined();
  return reply.result!;
}
async function discovery() {
  const discovered = result(await rpc('server/discover'));
  expect(discovered).toEqual({ resultType: 'complete', supportedVersions: [version],
    capabilities: { tools: {} }, serverInfo: { name: 'OpenCrane Odoo', version: '0.1.0' },
    _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'OpenCrane Odoo', version: '0.1.0' } },
    ttlMs: 0, cacheScope: 'public' });
  const listed = result(await rpc('tools/list'));
  expect(listed).toMatchObject({ resultType: 'complete', ttlMs: 0, cacheScope: 'public' });
  expect(listed['nextCursor']).toBeUndefined();
  const definitions = z.array(z.object({ name: z.string(), inputSchema: z.object({
    type: z.literal('object'), additionalProperties: z.literal(false) }),
    outputSchema: z.object({ type: z.literal('object') }),
    review: z.object({ targetArgument: z.literal('orderId'), fields: z.array(z.string()) }),
    annotations: z.object({ readOnlyHint: z.boolean(), destructiveHint: z.boolean() }),
    costCents: z.literal(0) })).parse(listed['tools']);
  expect(definitions.map(toolName)).toEqual(['read_draft_order', 'update_draft_order_note']);
  expect(definitions[0]?.annotations.readOnlyHint).toBe(true);
  expect(definitions[1]?.annotations.readOnlyHint).toBe(false);
  expect((await rpc('tools/list', { cursor: 'unknown' })).error).toBeDefined();
}
function toolName(tool: { name: string }) {
  return tool.name;
}
it('offers full credential-free discovery and complete tool definitions', discovery);

async function refusedProtocol() {
  const cases = [
    ['server/discover', {}, { 'mcp-protocol-version': '2025-03-26' }],
    ['server/discover', {}, { 'mcp-method': 'tools/list' }],
    ['server/discover', {}, { 'mcp-session-id': 'unwanted' }],
    ['tools/call', { name: 'read_draft_order', arguments: { orderId: 1 } },
      { 'mcp-name': 'other_tool' }],
    ['server/discover', { _meta: {} }, {}],
    ['server/discover', { _meta: { ...meta,
      'io.modelcontextprotocol/protocolVersion': '2025-03-26' } }, {}],
    ['initialize', {}, {}], ['resources/list', {}, {}],
  ] as const;
  for (const [method, params, headers] of cases) {
    expect((await rpc(method, params, undefined, headers)).error?.message).toBe('invalid_request');
  }
  expect((await fetch(endpoint)).status).toBe(405);
  const batch = await fetch(endpoint, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: '[]' });
  expect(batch.status).toBe(400);
  const malformed = [Buffer.from([0xff]), Buffer.from('x'.repeat(16385))];
  for (const body of malformed) {
    const response = await fetch(endpoint, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body });
    expect(response.status).toBe(400);
  }
}
it('refuses wrong versions, metadata, method headers, sessions and batches', refusedProtocol);

async function refusedArguments() {
  for (const extra of [{ identity: 'writer' }, { method: 'write' }, { context: {} }]) {
    const argumentsWithIdentity = { orderId: 1, ...extra };
    const call = { name: 'read_draft_order', arguments: argumentsWithIdentity };
    expect((await rpc('tools/call', call)).error?.message).toBe('invalid_request');
  }
  const arbitrary = { name: 'sale.order/write', arguments: {} };
  expect((await rpc('tools/call', arbitrary)).error?.message).toBe('unknown_tool');
  const read = { name: 'read_draft_order', arguments: { orderId: 1 } };
  expect((await rpc('tools/call', read)).error?.message).toBe('read_unavailable');
  const update = { orderId: 1, note: 'Replacement', expectedVersion: 'a'.repeat(64) };
  const write = { name: 'update_draft_order_note', arguments: update };
  expect((await rpc('tools/call', write)).error?.message).toBe('write_unavailable');
}
it('refuses identity, arbitrary methods and both tool executions', refusedArguments);
