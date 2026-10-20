import { buildServer } from '../src/server.ts';
import { testAuthConfig } from './support/test-auth-config.ts';
import { remoteFixture } from "@opencrane/models/testing/remote-mcp";
import { afterEach, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { natsFixture } from '@opencrane/event-store/testing';
import { registerRemote, discoveryStatus } from '../src/integrations/registration.ts';
import { installWorker } from '../src/integrations/install-worker.ts';
import { mcpServerDiscoveredDataSchema } from '@opencrane/events';

vi.setConfig({ testTimeout: 20_000 });
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanups.reverse()) await close(); cleanups.length = 0; });

it('quarantines a private DNS target and refuses callers without the install identity', async () => {
  const nats = await natsFixture(); cleanups.push(() => nats.close());
  const app = Fastify(); cleanups.push(() => app.close());
  const worker = installWorker(app, nats.store, 'test', { resolve: () => Promise.resolve([{ address: '127.0.0.1', family: 4 }]) });
  const change = await registerRemote(nats.store, 'test', 'admin', { locator: 'https://private.example.test/mcp' });
  expect((await app.inject({ method: 'POST', url: `/internal/mcp/${change.serverId}`, payload: { method: 'tools/call' } })).statusCode).toBe(403);
  await worker.discover(change.serverId);
  expect(await discoveryStatus(nats.store, 'test', change.serverId)).toMatchObject({ state: 'failed', reason: 'unsafe_address' });
});

it('discovers paginated tools over pinned HTTPS with complete metadata and immutable review evidence', async () => {
  const remote = await remoteFixture(); cleanups.push(remote.close);
  const nats = await natsFixture(); cleanups.push(() => nats.close());
  const app = Fastify(); cleanups.push(() => app.close());
  const worker = installWorker(app, nats.store, 'test', remote.network);
  const change = await registerRemote(nats.store, 'test', 'admin', { locator: 'https://mcp.example.test/mcp' });
  await worker.discover(change.serverId);
  const status = await discoveryStatus(nats.store, 'test', change.serverId);
  expect(status).toMatchObject({ state: 'needs_input', reason: 'pending_review', inventory: { toolCount: 2,
    tools: [{ name: 'read', reviewed: false, revision: '30ff85d411a7bb585e85ae4e935211f690b7f436efe85592868bb492a342aca6',
      definition: '{"annotations":{"readOnlyHint":true},"inputSchema":{"properties":{"id":{"type":"integer"}},"type":"object"},"name":"read"}' }, { name: 'write', reviewed: false }] } });
  expect(remote.calls.map(c => c.method)).toEqual(['server/discover', 'tools/list', 'tools/list']);
  expect(remote.pinned).toEqual(['93.184.216.34', '93.184.216.34', '93.184.216.34']);
  for (const call of remote.calls) {
    expect(call.hostname).toBe('mcp.example.test');
    expect(call.headers).toMatchObject({ 'mcp-method': call.method, 'mcp-protocol-version': '2026-07-28' });
    expect(call.headers['authorization']).toBeUndefined();
    expect(call.body).toMatchObject({ params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} } } });
  }
  await worker.discover(change.serverId);
  expect(remote.calls).toHaveLength(3);
  expect(await discoveryStatus(nats.store, 'test', change.serverId)).toEqual(status);
});

it('persists valid output schemas and safe per-tool rejections across HTTPS pages and worker restart', async () => {
  const remote = await remoteFixture(); cleanups.push(remote.close);
  const metadata = { resultType: 'complete', ttlMs: 1000, cacheScope: 'public' };
  const inputSchema = { type: 'object' };
  const definitions = [
    { name: 'list', inputSchema, outputSchema: { type: 'array', items: { type: 'string' } } },
    { name: 'scalar', inputSchema, outputSchema: { type: 'string' } },
    { name: 'anything', inputSchema, outputSchema: {} },
  ];
  remote.respond((method, cursor) => method === 'server/discover'
    ? { ...metadata, supportedVersions: ['2026-07-28'], capabilities: { tools: {} },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'Fixture', version: '1' } } }
    : { ...metadata, tools: cursor ? definitions : [
      { name: 'bad_header', inputSchema: { type: 'object', properties: {
        region: { type: 'string', 'x-mcp-header': 'Region\r\nfixture-secret' },
      } } },
      { name: 'bad_title', inputSchema, title: 42 },
      { name: 'bad_schema', inputSchema: { type: 'object', required: 'fixture-secret' } },
    ], ...(cursor ? {} : { nextCursor: 'valid-tools' }) });
  const nats = await natsFixture(); cleanups.push(() => nats.close());
  const app = Fastify(); cleanups.push(() => app.close());
  const worker = installWorker(app, nats.store, 'test', remote.network);
  const change = await registerRemote(nats.store, 'test', 'admin', { locator: 'https://mcp.example.test/mcp' });
  await worker.discover(change.serverId);
  const status = await discoveryStatus(nats.store, 'test', change.serverId);
  expect(status).toMatchObject({ state: 'needs_input', reason: 'pending_review', inventory: { toolCount: 3,
    tools: definitions.map(definition => ({ name: definition.name, reviewed: false })),
    rejectedTools: [
      { name: 'bad_header', reason: 'invalid_header_name' },
      { name: 'bad_title', reason: 'invalid_tool_title' },
      { name: 'bad_schema', reason: 'invalid_input_schema' },
    ],
  } });
  const saved = mcpServerDiscoveredDataSchema.parse(status!.inventory);
  expect(saved.tools!.map(t => JSON.parse(t.definition!) as unknown)).toEqual(definitions);
  for (const rejected of saved.rejectedTools!) expect(rejected.revision).toMatch(/^[a-f0-9]{64}$/u);
  expect(JSON.stringify(status)).not.toContain('fixture-secret');
  await app.close();
  const restarted = Fastify(); cleanups.push(() => restarted.close());
  const resumed = installWorker(restarted, nats.store, 'test', remote.network);
  remote.respond(() => { throw new Error('Completed discovery must not contact the server'); });
  await resumed.discover(change.serverId);
  expect(await discoveryStatus(nats.store, 'test', change.serverId)).toEqual(status);
});

it.each([
  ['mixed_dns', 'unsafe_address'], ['rebinding', 'unsafe_address'], ['redirect', 'redirect_refused'], ['invalid_tls', 'network_refused'],
  ['protected', 'connection_required'], ['forbidden', 'connection_required'], ['legacy', 'protocol_refused'], ['missing_metadata', 'protocol_refused'],
  ['duplicate_tools', 'duplicate_tools'], ['cursor_loop', 'pagination_limit'],
  ['too_many_tools', 'protocol_refused'], ['large_response', 'response_limit'], ['timeout', 'discovery_timeout'],
  ['duplicate_keys', 'protocol_refused'], ['session', 'protocol_refused'], ['page_limit', 'pagination_limit'], ['inventory_limit', 'inventory_limit'], ['metadata_limit', 'inventory_limit'],
])('safely refuses %s through the quarantine discovery route', async (mode, reason) => {
  const remote = await remoteFixture(); cleanups.push(remote.close);
  if (mode === 'mixed_dns') remote.setAnswers(['93.184.216.34', '169.254.169.254']);
  if (mode === 'rebinding') remote.rebind();
  if (mode === 'redirect') remote.status(302);
  if (mode === 'invalid_tls') remote.untrust();
  if (mode === 'protected') remote.status(401);
  if (mode === 'forbidden') {
    remote.status(403);
  }
  const full = { resultType: 'complete', supportedVersions: ['2026-07-28'], capabilities: { tools: {} }, _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'Fixture', version: '1' } }, ttlMs: 1000, cacheScope: 'public' };
  const tool = { name: 'read', inputSchema: { type: 'object' } };
  if (mode === 'legacy') remote.respond(() => ({ ...full, supportedVersions: ['2025-06-18'] }));
  if (mode === 'missing_metadata') remote.respond(() => ({ ...full, ttlMs: undefined }));
  if (mode === 'duplicate_tools') remote.respond(method => method === 'server/discover' ? full : { ...full, tools: [tool, tool] });
  if (mode === 'cursor_loop') remote.respond(method => method === 'server/discover' ? full : { ...full, tools: [], nextCursor: 'same' });
  if (mode === 'too_many_tools') remote.respond(method => method === 'server/discover' ? full : { ...full, tools: Array.from({ length: 101 }, (_, i) => ({ ...tool, name: `tool${i}` })) });
  if (mode === 'large_response') remote.respond(() => ({ ...full, instructions: 'x'.repeat(4 * 1024 * 1024) }));
  let pages = 0;
  if (mode === 'page_limit') remote.respond(method => method === 'server/discover' ? full : { ...full, tools: [], nextCursor: `page-${++pages}` });
  if (mode === 'inventory_limit') remote.respond(method => method === 'server/discover' ? full : { ...full, tools: Array.from({ length: 40 }, (_, i) => ({ ...tool, name: `tool${i}`, description: 'x'.repeat(16000) })) });
  if (mode === 'metadata_limit') remote.respond(() => ({ ...full, instructions: 'x'.repeat(65536) }));
  if (mode === 'timeout') remote.respond(() => undefined);
  if (mode === 'duplicate_keys') remote.respond(() => '{"jsonrpc":"2.0","id":"REQUEST_ID","result":{},"result":{}}');
  if (mode === 'session') remote.respond(() => ({ protocolVersion: '2026-07-28', capabilities: {} }));
  const nats = await natsFixture(); cleanups.push(() => nats.close());
  const app = Fastify(); cleanups.push(() => app.close());
  const worker = installWorker(app, nats.store, 'test', { ...remote.network, deadlineMs: 2000 });
  const change = await registerRemote(nats.store, 'test', 'admin', { locator: 'https://mcp.example.test/mcp' });
  await worker.discover(change.serverId);
  const protectedServer = mode === 'protected' || mode === 'forbidden';
  const state = protectedServer ? 'needs_input' : 'failed';
  expect(await discoveryStatus(nats.store, 'test', change.serverId)).toMatchObject({ state, reason });
  if (mode === 'page_limit') expect(remote.calls).toHaveLength(11);
  if (mode === 'mixed_dns') expect(remote.calls).toHaveLength(0);
  if (mode === 'rebinding') expect(remote.calls.map(c => c.method)).toEqual(['server/discover']);
  const count = remote.calls.length;
  await worker.discover(change.serverId);
  expect(remote.calls).toHaveLength(count);
});

it.each(['0.0.0.0', '10.0.0.1', '127.0.0.1', '169.254.169.254', '172.16.1.1', '192.168.1.1', '100.64.0.1',
  '192.0.0.1', '192.0.2.1', '192.88.99.1', '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255',
  '::', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', 'ff02::1', '2001:db8::1', '2002::1', '2001::1', '3fff::1', '3ffe::1'])('refuses special-purpose DNS answer %s', async address => {
  const nats = await natsFixture(); cleanups.push(() => nats.close());
  const app = Fastify(); cleanups.push(() => app.close());
  const worker = installWorker(app, nats.store, 'test', { resolve: () => Promise.resolve([{ address, family: address.includes(':') ? 6 : 4 }]) });
  const change = await registerRemote(nats.store, 'test', 'admin', { locator: 'https://mcp.example.test/mcp' });
  await worker.discover(change.serverId);
  expect(await discoveryStatus(nats.store, 'test', change.serverId)).toMatchObject({ reason: 'unsafe_address' });
});

it('limits a live install identity to its server and discovery methods, strips forged headers and expires it', async () => {
  const remote = await remoteFixture(); cleanups.push(remote.close);
  const nats = await natsFixture(); cleanups.push(() => nats.close());
  const app = Fastify(); cleanups.push(() => app.close());
  let token: string | undefined;
  const refusals: number[] = [];
  app.addHook('onRequest', async req => {
    if (token || !req.headers.authorization) return;
    token = req.headers.authorization;
    for (const method of ['tools/call', 'initialize', 'resources/list', 'Tools/List']) {
      refusals.push((await app.inject({ method: 'POST', url: req.url, headers: { authorization: token }, payload: { method } })).statusCode);
    }
    refusals.push((await app.inject({ method: 'POST', url: '/internal/mcp/foreign', headers: { authorization: token }, payload: { method: 'tools/list' } })).statusCode);
    refusals.push((await app.inject({ method: 'POST', url: req.url, headers: { authorization: token }, payload: { method: 'tools/list', locator: 'https://attacker.test/' } })).statusCode);
    refusals.push((await app.inject({ method: 'GET', url: req.url, headers: { authorization: token } })).statusCode);
    refusals.push((await app.inject({ method: 'POST', url: req.url, headers: { authorization: token, 'content-type': 'application/json' }, payload: '{"method":"tools/list","method":"server/discover"}' })).statusCode);
    refusals.push((await app.inject({ method: 'POST', url: req.url, headers: { authorization: token }, payload: { method: 'tools/list', cursor: 'x'.repeat(1024 * 1024) } })).statusCode);
    const allowed = await app.inject({ method: 'POST', url: req.url, headers: { authorization: token, cookie: 'private', 'x-api-key': 'forged', 'mcp-session-id': 'legacy', 'mcp-method': 'tools/call' }, payload: { method: 'server/discover' } });
    expect(allowed.statusCode).toBe(200);
  });
  const worker = installWorker(app, nats.store, 'test', remote.network);
  const change = await registerRemote(nats.store, 'test', 'admin', { locator: 'https://mcp.example.test/mcp' });
  await worker.discover(change.serverId);
  expect(refusals).toEqual([422, 422, 422, 422, 403, 422, 404, 500, 413]);
  expect(remote.calls.map(c => c.method)).toEqual(['server/discover', 'server/discover', 'tools/list', 'tools/list']);
  for (const call of remote.calls) for (const name of ['cookie', 'x-api-key', 'authorization', 'mcp-session-id']) expect(call.headers[name]).toBeUndefined();
  expect((await app.inject({ method: 'POST', url: `/internal/mcp/${change.serverId}`, headers: { authorization: token! }, payload: { method: 'tools/list' } })).statusCode).toBe(403);
});

it('bounds DNS stalls without leaving an upstream request alive', async () => {
  const nats = await natsFixture(); cleanups.push(() => nats.close());
  const app = Fastify(); cleanups.push(() => app.close());
  const worker = installWorker(app, nats.store, 'test', { resolve: () => new Promise(() => {}), deadlineMs: 25 });
  const change = await registerRemote(nats.store, 'test', 'admin', { locator: 'https://mcp.example.test/mcp' });
  await worker.discover(change.serverId);
  expect(await discoveryStatus(nats.store, 'test', change.serverId)).toMatchObject({ state: 'failed', reason: 'discovery_timeout' });
});


it('does not log credentials embedded in a refused status lookup', async () => {
  vi.stubEnv('LOG_LEVEL', 'info');
  let logs = '';
  const app = buildServer(testAuthConfig(), { logDestination: { write: (line: string) => { logs += line; } } });
  try {
    const locator = encodeURIComponent('https://user:fixture-password@public.test/mcp?api_key=fixture-api-key');
    for (const name of ['locator', 'LOCATOR', 'loc%61tor']) expect((await app.inject({ url: `/api/org/integrations/discovery?${name}=${locator}` })).statusCode).toBe(401);
    expect(logs).toContain('incoming request');
    expect(logs).not.toContain('fixture-password');
    expect(logs).not.toContain('fixture-api-key');
  } finally { await app.close(); vi.unstubAllEnvs(); }
});
