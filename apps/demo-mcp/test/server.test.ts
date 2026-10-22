import { afterEach, beforeEach, expect, it } from 'vitest';
import { createDemoServer } from '../src/server.ts';
import { discoverInventory } from '../../server/src/integrations/inventory.ts';

const version = '2026-07-28';
const metadata = { 'io.modelcontextprotocol/protocolVersion': version };
const quote = { quoteId: 'DEMO-001' };
const change = { ...quote, slot: 'afternoon' };
let server: ReturnType<typeof createDemoServer>;
let revision = '';

function wire(method = 'tools/call', name = 'change_delivery_slot', args: unknown = change) {
  const params = method === 'tools/call' ? { _meta: metadata, name, arguments: args }
    : { _meta: metadata };
  return { jsonrpc: '2.0', id: 'demo-request', method, params };
}
function headers(method = 'tools/call', name = 'change_delivery_slot') {
  return { 'content-type': 'application/json', 'mcp-protocol-version': version,
    'mcp-method': method, 'mcp-name': name, 'x-opencrane-mcp-revision': revision };
}
async function inventoryCall(method: 'server/discover' | 'tools/list') {
  const response = await server.inject({ method: 'POST', url: '/',
    headers: headers(method, ''), payload: wire(method) });
  const parsed = response.json<{ result: unknown }>();
  expect(response.headers['content-type']).toContain('application/json');
  expect(response.headers['mcp-session-id']).toBeUndefined();
  return JSON.stringify(parsed.result);
}
async function readFixture() {
  const response = await server.inject({ method: 'POST', url: '/',
    headers: headers('tools/call', 'read_fixture_quote'),
    payload: wire('tools/call', 'read_fixture_quote', quote) });
  return response.json<{ result: { structuredContent: unknown } }>().result.structuredContent;
}
async function prepare() {
  server = createDemoServer();
  const inventory = await discoverInventory(inventoryCall);
  revision = inventory.schemaDigest;
}
beforeEach(prepare);
async function close() {
  await server.close();
}
afterEach(close);

async function describePublicTools() {
  const inventory = await discoverInventory(inventoryCall);
  expect(inventory.rejectedTools).toEqual([]);
  expect(inventory.tools).toHaveLength(2);
  for (const tool of inventory.tools ?? []) {
    expect(tool.costCents).toBe(0);
    expect(tool.review?.stepUp).toBe(false);
    expect(tool.review?.targetArgument).toBe('quoteId');
    expect(tool.review?.fields).toContain('quoteId');
    expect(tool.reviewed).toBe(false);
  }
  const discovery: unknown = JSON.parse(await inventoryCall('server/discover'));
  expect(discovery).toMatchObject({ resultType: 'complete', ttlMs: 300000,
    cacheScope: 'public', supportedVersions: [version],
    serverInfo: { name: 'OpenCrane demo', version: '0.1.0' },
    capabilities: { tools: {}, experimental: { 'io.opencrane/expectedRevision': {} } } });
  const catalogue: unknown = JSON.parse(await inventoryCall('tools/list'));
  expect(catalogue).toMatchObject({ resultType: 'complete', ttlMs: 300000, cacheScope: 'public' });
  expect(catalogue).not.toHaveProperty('nextCursor');
}
it('offers complete public discovery and exact zero-cost review declarations', describePublicTools);

async function changeOnceAndReset() {
  expect(await readFixture()).toMatchObject({ ...quote, amountCents: 12500,
    slot: 'morning', effectCount: 0 });
  const payload = wire();
  payload.params._meta = { ...metadata, ...{
    'io.modelcontextprotocol/clientCapabilities': {},
    'io.modelcontextprotocol/clientInfo': { name: 'Codex', version: 'test' },
    threadId: 'thread', callId: 'call', sessionId: 'session', windowId: 'window',
    itemId: 'item', progressToken: 1, 'x-codex-turn-metadata': { thread_id: 'thread' },
  } };
  const response = await server.inject({ method: 'POST', url: '/', headers: headers(), payload });
  expect(response.json()).toMatchObject({ jsonrpc: '2.0', id: payload.id,
    result: { isError: false, structuredContent: { ...change, effectCount: 1 } } });
  expect(await readFixture()).toMatchObject({ ...change, effectCount: 1 });
  await server.close();
  server = createDemoServer();
  expect(await readFixture()).toMatchObject({ slot: 'morning', effectCount: 0 });
}
it('echoes ids and changes only this process once per accepted call', changeOnceAndReset);

const refusals = [
  { label: 'empty revision', patch: { 'x-opencrane-mcp-revision': '' } },
  { label: 'wrong revision', patch: { 'x-opencrane-mcp-revision': '0'.repeat(64) } },
  { label: 'header version', patch: { 'mcp-protocol-version': '2025-03-26' } },
  { label: 'method disagreement', patch: { 'mcp-method': 'tools/list' } },
  { label: 'name disagreement', patch: { 'mcp-name': 'read_fixture_quote' } },
  { label: 'session', patch: { 'mcp-session-id': 'sensitive-marker' } },
  { label: 'credential', patch: { authorization: 'Bearer sensitive-marker' } },
  { label: 'media type', patch: { 'content-type': 'text/plain' } },
];
async function refuseHeaders({ patch }: (typeof refusals)[number]) {
  const response = await server.inject({ method: 'POST', url: '/',
    headers: { ...headers(), ...patch }, payload: JSON.stringify(wire()) });
  expect(response.json()).toHaveProperty('error');
  expect(response.body).not.toContain('sensitive-marker');
  expect(await readFixture()).toMatchObject({ effectCount: 0 });
}
it.each(refusals)('refuses $label before an effect', refuseHeaders);

const invalidBodies = [
  JSON.stringify(wire('initialize')), JSON.stringify(wire('initialise')),
  JSON.stringify(wire('notifications/initialized')),
  JSON.stringify({ ...wire(), id: undefined }), JSON.stringify([wire()]),
  JSON.stringify(wire('tools/call', 'unknown_tool')),
  JSON.stringify(wire('tools/call', 'change_delivery_slot', { ...change, extra: 'sensitive-marker' })),
  JSON.stringify(wire('tools/call', 'change_delivery_slot', { ...change, slot: 'evening' })),
  JSON.stringify(wire('tools/call', 'read_fixture_quote', { quoteId: 'OTHER' })),
  JSON.stringify(wire()).replace(version, '2025-03-26'),
  JSON.stringify(wire()).replace('"slot":"afternoon"', '"slot":"morning","slot":"afternoon"'),
  JSON.stringify(wire()).replace('"id":"demo-request"', '"id":1,"id":2'),
  JSON.stringify({ ...wire(), params: { ...wire().params, cursor: 'next' } }),
  JSON.stringify({ ...wire(), params: { ...wire().params, _meta: { ...metadata, extra: true } } }),
  JSON.stringify({ ...wire(), params: { ...wire().params,
    _meta: { ...metadata, progressToken: 'x'.repeat(201) } } }),
];
async function refuseInvalidBody(payload: string) {
  const response = await server.inject({ method: 'POST', url: '/', headers: headers(), payload });
  expect(response.json()).toHaveProperty('error');
  expect(response.body).not.toContain('sensitive-marker');
  expect(await readFixture()).toMatchObject({ effectCount: 0 });
}
it.each(invalidBodies)('refuses invalid input %# before an effect', refuseInvalidBody);

async function refuseOversizedCall() {
  const payload = JSON.stringify(wire()) + ' '.repeat(16384);
  const response = await server.inject({ method: 'POST', url: '/', headers: headers(), payload });
  expect.soft(await readFixture()).toMatchObject({ effectCount: 0 });
  expect(response.json()).toHaveProperty('error');
}
it('refuses an otherwise valid call padded past the byte limit', refuseOversizedCall);

async function refuseMalformedUtf8() {
  const payload = Buffer.from(JSON.stringify(wire()));
  // Corrupt the id so replacement decoding would leave an otherwise valid call.
  payload[payload.indexOf('demo-request')] = 0xff;
  const response = await server.inject({ method: 'POST', url: '/', headers: headers(), payload });
  expect.soft(await readFixture()).toMatchObject({ effectCount: 0 });
  expect(response.json()).toHaveProperty('error');
}
it('refuses malformed UTF-8 inside a JSON string before an effect', refuseMalformedUtf8);

async function refuseListArguments() {
  const payload = {
    ...wire('tools/list'),
    params: { _meta: metadata, arguments: { unexpected: true } },
  };
  const response = await server.inject({
    method: 'POST', url: '/', headers: headers('tools/list', ''), payload,
  });
  expect.soft(await readFixture()).toMatchObject({ effectCount: 0 });
  expect(response.json()).toHaveProperty('error');
}
it('refuses tools/list arguments even when headers agree', refuseListArguments);

async function acceptConcurrentCalls() {
  const firstCall = server.inject({
    method: 'POST', url: '/', headers: headers(), payload: { ...wire(), id: 'first' },
  });
  const secondCall = server.inject({
    method: 'POST', url: '/', headers: headers(), payload: { ...wire(), id: 'second' },
  });
  const [firstResponse, secondResponse] = await Promise.all([firstCall, secondCall]);
  expect(firstResponse.json()).toMatchObject({
    id: 'first', result: { isError: false, structuredContent: { ...change, effectCount: 1 } },
  });
  expect(secondResponse.json()).toMatchObject({
    id: 'second', result: { isError: false, structuredContent: { ...change, effectCount: 2 } },
  });
  expect(await readFixture()).toMatchObject({ ...change, effectCount: 2 });
  const inventory = await discoverInventory(inventoryCall);
  expect(inventory.schemaDigest).toBe(revision);
}
it('accepts two concurrent calls with the same catalogue revision once each', acceptConcurrentCalls);

async function refuseSessionMethod(method: 'GET' | 'DELETE') {
  const response = await server.inject({ method, url: '/' });
  expect(response.statusCode).toBe(405);
  expect(response.headers['mcp-session-id']).toBeUndefined();
  expect(await readFixture()).toMatchObject({ effectCount: 0 });
}
it.each(['GET', 'DELETE'] as const)('refuses %s without a session', refuseSessionMethod);

async function refuseUnsupportedMethod(method: string) {
  const response = await server.inject({ method: 'POST', url: '/',
    headers: headers(method, ''), payload: wire(method) });
  expect(response.json()).toHaveProperty('error');
  expect(await readFixture()).toMatchObject({ effectCount: 0 });
}
it.each(['initialize', 'initialise', 'notifications/initialized', 'resources/list'])(
  'refuses unsupported %s even when headers agree', refuseUnsupportedMethod);

async function serveLocalSocket() {
  const address = await server.listen({ host: '127.0.0.1', port: 0 });
  const withoutRevision: Record<string, string> = headers();
  delete withoutRevision['x-opencrane-mcp-revision'];
  const refused = await fetch(address, { method: 'POST', headers: withoutRevision,
    body: JSON.stringify(wire()) });
  expect(await refused.json()).toMatchObject({ error: { message: 'revision_mismatch' } });
  expect(await readFixture()).toMatchObject({ effectCount: 0 });
  const response = await fetch(address, { method: 'POST', headers: headers(),
    body: JSON.stringify({ ...wire(), id: 7 }) });
  expect(response.headers.get('content-type')).toContain('application/json');
  expect(response.headers.get('mcp-session-id')).toBeNull();
  expect(await response.json()).toMatchObject({ id: 7,
    result: { structuredContent: { effectCount: 1 } } });
}
it('requires a revision and serves JSON over a real local socket', serveLocalSocket);

async function refuseInvalidArguments(name: string) {
  const response = await server.inject({ method: 'POST', url: '/',
    headers: headers('tools/call', name),
    payload: wire('tools/call', name, { ...quote, extra: 'sensitive-marker' }) });
  expect(response.json()).toHaveProperty('error');
  expect(response.body).not.toContain('sensitive-marker');
  expect(await readFixture()).toMatchObject({ effectCount: 0 });
}
it.each(['read_fixture_quote', 'change_delivery_slot', 'unknown_tool'])(
  'checks arguments and tool names for %s with matching headers', refuseInvalidArguments);
