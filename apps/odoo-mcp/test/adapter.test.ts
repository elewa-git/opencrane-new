import { afterAll, beforeAll, expect, it } from 'vitest';
import { z } from 'zod';
import { createAdapter } from '../src/server.ts';
import { discover } from '../src/tools.ts';

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

const noteCases = [
  { byteLength: 2047, trailingSpaces: 1, message: 'write_unavailable' },
  { byteLength: 2048, trailingSpaces: 2, message: 'write_unavailable' },
  { byteLength: 2049, trailingSpaces: 3, message: 'invalid_request' },
];

async function multibyteNote(testCase: typeof noteCases[number]) {
  const note = '€'.repeat(682) + ' '.repeat(testCase.trailingSpaces);
  expect(Buffer.byteLength(note, 'utf8')).toBe(testCase.byteLength);
  const argumentsForWrite = { orderId: 1, note, expectedVersion: 'a'.repeat(64) };
  const call = { name: 'update_draft_order_note', arguments: argumentsForWrite };
  const response = await rpc('tools/call', call);
  expect(response.error?.message).toBe(testCase.message);
}
it.each(noteCases)('checks a multibyte note of $byteLength UTF-8 bytes without trimming',
  multibyteNote);

async function advertisedNoteBound() {
  const listed = result(await rpc('tools/list'));
  const noteDefinition = z.object({
    type: z.literal('string'),
    description: z.literal('At most 2,048 UTF-8 bytes (2 KiB). The note is not trimmed.'),
  });
  const toolDefinition = z.object({
    inputSchema: z.object({ properties: z.object({ note: noteDefinition.optional() }) }),
    outputSchema: z.object({ properties: z.object({
      snapshot: z.object({ properties: z.object({
        note: z.object({ anyOf: z.tuple([noteDefinition, z.unknown()]) }),
      }) }).optional(),
    }) }),
  });
  const definitions = z.array(toolDefinition).parse(listed['tools']);
  expect(definitions[1]?.inputSchema.properties.note).toBeDefined();
  expect(definitions[0]?.outputSchema.properties.snapshot).toBeDefined();
}
it('advertises the UTF-8 byte bound for input and snapshot notes', advertisedNoteBound);

function discoveryBody() {
  return { jsonrpc: '2.0', id: 'test', method: 'server/discover', params: { _meta: meta } };
}

async function postDiscoveryBody(body: Buffer) {
  const headers = {
    'content-type': 'application/json',
    'mcp-protocol-version': version,
    'mcp-method': 'server/discover',
  };
  const bytes = new Uint8Array(body);
  const options = { method: 'POST', headers, body: bytes };
  return fetch(endpoint, options);
}

async function oversizedValidJson() {
  const body = discoveryBody();
  const paddedMetadata = {
    ...meta,
    'io.modelcontextprotocol/clientCapabilities': { padding: 'x'.repeat(16384) },
  };
  body.params._meta = paddedMetadata;
  const bytes = Buffer.from(JSON.stringify(body));
  expect(bytes.byteLength).toBeGreaterThan(16384);
  const response = await postDiscoveryBody(bytes);
  expect(response.status).toBe(400);
  const refused: unknown = await response.json();
  expect(refused).toMatchObject({ id: null, error: { message: 'invalid_request' } });
}
it('refuses a valid discovery JSON body over 16 KiB', oversizedValidJson);

async function invalidUtf8String() {
  const body = discoveryBody();
  body.id = '#';
  const bytes = Buffer.from(JSON.stringify(body));
  const stringIndex = bytes.indexOf('#');
  expect(stringIndex).toBeGreaterThan(0);
  bytes[stringIndex] = 0xff;
  const response = await postDiscoveryBody(bytes);
  expect(response.status).toBe(400);
  const refused: unknown = await response.json();
  expect(refused).toMatchObject({ id: null, error: { message: 'invalid_request' } });
}
it('refuses a lone 0xff inside an otherwise valid JSON string', invalidUtf8String);

async function oversizedReply() {
  const originalName = discover.serverInfo.name;
  // Restore the catalogue after supplying an oversized result to the HTTP adapter.
  try {
    discover.serverInfo.name = 'x'.repeat(65536);
    const response = await rpc('server/discover');
    expect(response.result).toBeUndefined();
    expect(response.error?.message).toBe('record_limit');
    expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThanOrEqual(65536);
  } finally {
    discover.serverInfo.name = originalName;
  }
}
it('refuses a discovery reply over 64 KiB', oversizedReply);
