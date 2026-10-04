import { z } from 'zod';
import { readFile, writeFile } from 'node:fs/promises';
import { until } from '@opencrane/authz/testing';
import { remoteFixture } from './support/remote-mcp.ts';
import { guardedMcp } from '../src/integrations/guarded-mcp.ts';
import { grantStream } from '@opencrane/authz';
import { expect, it } from 'vitest';
import { fixture } from '@opencrane/models/testing';
import { publishMcp, publicationStatus, acknowledgeMcp } from '@opencrane/models';
import { grantMcp, mcpGrants, readToolPolicy, history } from '@opencrane/models';
import { connectMcpCatalogue, mcpCatalogue } from '@opencrane/projections';

it('publishes one reviewed generation, stays Applying until its exact acknowledgement, and replays without effects', async () => {
  const f = await fixture();
  try {
    await f.append('mcp-fixture', 'mcp.server_registered', { serverId: 'fixture', kind: 'remote', locator: 'https://mcp.example.test/mcp', registeredBy: 'alice' });
    await f.append('mcp-fixture', 'mcp.server_discovered', { serverId: 'fixture', schemaDigest: 'a'.repeat(64), toolCount: 1,
      tools: [{ name: 'read', revision: 'b'.repeat(64), reviewed: false, readOnly: true, definition: '{"name":"read","inputSchema":{"type":"object"}}' }] });
    const command = { commandId: 'review-1', expectedSequence: (await readToolPolicy(f.nats.store, 'test', 'fixture')).sequence,
      schemaDigest: 'a'.repeat(64), accountMode: 'none', tools: [{ name: 'read', revision: 'b'.repeat(64), mode: 'allow', costCents: 0 }] };
    const results = await Promise.all([publishMcp(f.nats.store, f.binding, 'alice', 'fixture', command), publishMcp(f.nats.store, f.binding, 'alice', 'fixture', command)]);
    expect(results.some(r => r.status === 'appended')).toBe(true);
    const applying = await publicationStatus(f.nats.store, 'test', 'fixture');
    expect(applying).toMatchObject({ state: 'applying', changeRef: 'review-1' });
    expect((await readToolPolicy(f.nats.store, 'test', 'fixture')).published).toBe(false);
    expect((await history(f.nats.store, 'mcp-fixture', 'test')).filter(r => r.event.type === 'mcp.server_published')).toHaveLength(1);
    expect(await acknowledgeMcp(f.nats.store, 'test', 'fixture', 'review-1', 'c'.repeat(64))).toBe(false);
    expect(await acknowledgeMcp(f.nats.store, 'test', 'fixture', 'review-1', applying.digest!)).toBe(true);
    expect(await publicationStatus(f.nats.store, 'test', 'fixture')).toMatchObject({ state: 'ready' });
    await f.runner.initialise(mcpCatalogue); await f.runner.run(mcpCatalogue);
    const catalogue = connectMcpCatalogue(f.dbUrl);
    expect((await catalogue.rows('test'))[0]?.status.kind).toBe('ready');
    const before = await catalogue.tools('test', 'fixture');
    await f.runner.rebuild(mcpCatalogue);
    expect(await catalogue.tools('test', 'fixture')).toEqual(before);
    expect(f.received()).toBe(0); await catalogue.close();
  } finally { await f.close(); }
}, 40_000);

it('refuses an unacknowledged or stale gateway generation even when the old route still exists', async () => {
  const f = await fixture();
  try {
    await f.append('mcp-fixture', 'mcp.server_registered', { serverId: 'fixture', kind: 'remote', locator: 'https://mcp.example.test/mcp', registeredBy: 'alice' });
    await f.append('mcp-fixture', 'mcp.server_discovered', { serverId: 'fixture', connectionId: 'installed', schemaDigest: 'a'.repeat(64), toolCount: 1,
      tools: [{ name: 'read', revision: 'b'.repeat(64), reviewed: false }] });
    await f.publish();
    const status = await publicationStatus(f.nats.store, 'test', 'fixture');
    expect(status.state).toBe('ready');
    expect(await f.gatewayAcknowledgements()).toEqual([{ serverId: 'fixture', changeRef: status.changeRef, digest: status.digest }]);
    await f.append('mcp-fixture', 'mcp.server_unpublished', { serverId: 'fixture', unpublishedBy: 'alice' });
    expect(await acknowledgeMcp(f.nats.store, 'test', 'fixture', status.changeRef!, status.digest!)).toBe(false);
    expect((await readToolPolicy(f.nats.store, 'test', 'fixture')).published).toBe(false);
    expect(f.received()).toBe(0);
  } finally { await f.close(); }
}, 40_000);

it('forwards published calls through guarded HTTPS and refuses rebinding after review', async () => {
  const remote = await remoteFixture();
  const f = await fixture(2000, 20000, false, 'gpt-6-luna', true);
  const adapter = await guardedMcp(f.nats.store, 'test', f.takeMcpPermit, remote.network);
  try {
    await f.append('mcp-fixture', 'mcp.server_registered', { serverId: 'fixture', kind: 'remote', locator: 'https://mcp.example.test/mcp', registeredBy: 'alice' });
    await f.append('mcp-fixture', 'mcp.server_discovered', { serverId: 'fixture', connectionId: 'installed', schemaDigest: 'a'.repeat(64), toolCount: 1,
      tools: [{ name: 'read', revision: 'b'.repeat(64), reviewed: false, costCents: 0, definition: JSON.stringify({ inputSchema: { type: 'object', properties: { region: { type: 'string', 'x-mcp-header': 'Region' }, nested: { type: 'object', properties: { limit: { type: 'integer', 'x-mcp-header': 'Limit' }, enabled: { type: 'boolean', 'x-mcp-header': 'Enabled' } } } } } }) }] });
    await f.publish();
    await f.append('mcp-fixture', 'mcp.tool_mode_set', { serverId: 'fixture', connectionId: 'installed', toolName: 'read', toolRevision: 'b'.repeat(64), mode: 'allow', setBy: 'alice' });
    f.options.mcpRoutes[0]!.upstream = adapter.host; await f.restart();
    const body = JSON.stringify({ jsonrpc: '2.0', id: 'published-call', method: 'tools/call', params: { name: 'read', arguments: { region: ' padded ', nested: { limit: 42, enabled: true } },
      _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': { experimental: {} }, 'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1' } } } });
    const call = (raw = body, extra = {}) => fetch(`http://127.0.0.1:${f.options.port}/mcp/fixture/installed`, { method: 'POST', headers: { ...f.headers,
      'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call', 'mcp-name': 'read', cookie: 'private', 'x-api-key': 'forged', 'x-mcp-permit': 'forged', 'mcp-param-region': '=?base64?IHBhZGRlZCA=?=', 'mcp-param-limit': '42', 'mcp-param-enabled': 'true', ...extra }, body: raw });
    expect((await call()).status).toBe(403);
    for (const [granteeId, granteeKind] of [['sales', 'team'], ['assistant', 'assistant']]) {
      const { sequence } = await mcpGrants(f.nats.store, 'test', 'fixture');
      expect((await grantMcp(f.nats.store, f.binding, 'alice', 'fixture', { commandId: `grant-${granteeId}`, expectedSequence: sequence, granteeId, granteeKind, action: 'give' })).status).toBe('appended');
      expect((await call()).status).toBe(403); // Missing counterpart or projection lag cannot grant permission.
      const event = (await history(f.nats.store, grantStream('mcp_server', 'fixture'), 'test')).at(-1)!.event;
      await f.auth.handler.handle(event, f.db);
    }
    expect((await call()).status).toBe(200);
    expect(remote.calls).toHaveLength(1);
    expect(remote.calls[0]!.headers).toMatchObject({ 'mcp-name': 'read', 'mcp-param-region': '=?base64?IHBhZGRlZCA=?=', 'mcp-param-limit': '42', 'mcp-param-enabled': 'true' });
    for (const name of ['authorization', 'x-turn-token', 'cookie', 'x-api-key', 'session-id', 'x-mcp-permit']) expect(remote.calls[0]!.headers[name]).toBeUndefined();
    for (const method of ['server/discover', 'tools/list']) {
      const metadata = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} };
      expect((await call(JSON.stringify({ jsonrpc: '2.0', id: method, method, params: { _meta: metadata } }), { 'mcp-method': method, 'mcp-name': '' })).status).toBe(200);
    }
    for (const argumentsValue of [{}, { region: null }, { region: 'é' }]) {
      const raw = body.replace('"arguments":{"region":" padded ","nested":{"limit":42,"enabled":true}}', `"arguments":${JSON.stringify(argumentsValue)}`);
      expect((await call(raw, { 'mcp-param-region': '=?base64?w6k=?=' })).status).toBe(200);
    }
    expect(remote.calls[3]!.headers['mcp-param-region']).toBeUndefined();
    expect(remote.calls[4]!.headers['mcp-param-region']).toBeUndefined();
    expect(remote.calls[5]!.headers['mcp-param-region']).toBe('=?base64?w6k=?=');
    expect(remote.calls).toHaveLength(6);
    const invalid = [body.replace('"limit":42', '"limit":9007199254740993'), body.replace('"limit":42', '"limit":42.000000000000000001'), body.replace('tools/call', 'Tools/Call'), body.replace('tools/call', 'resources/list'), body.replace('tools/call', 'initialize'),
      `[${body}]`, body.replace('"arguments":{"region":" padded ","nested":{"limit":42,"enabled":true}}', '"arguments":{"x":1,"x":2}'), body.replace('"arguments":{"region":" padded ","nested":{"limit":42,"enabled":true}}', '"arguments":{"constructor":1}'),
      body.replace('2026-07-28', '2025-06-18'), body.replace('"_meta":', '"missing":'), body.replace('"read"', '"unknown"'),
      body.replace('"arguments":{"region":" padded ","nested":{"limit":42,"enabled":true}}', `"arguments":{"large":"${'x'.repeat(1_048_576)}"}`)];
    for (const raw of invalid) expect((await call(raw)).status).toBeGreaterThanOrEqual(400);
    for (const extra of [{ 'mcp-param-region': 'forged' }, { 'mcp-method': 'tools/list' }, { 'mcp-name': 'unknown' }, { 'mcp-session-id': 'old' }, { 'mcp-protocol-version': '' }]) expect((await call(body, extra)).status).toBeGreaterThanOrEqual(400);
    expect((await fetch(`http://127.0.0.1:${f.options.port}/mcp/fixture/installed`, { headers: f.headers })).status).toBeGreaterThanOrEqual(400);
    expect(remote.calls).toHaveLength(6);
    // A partial generation without ext_authz or CEL still cannot use the guarded transport.
    const original = await readFile(f.options.configFile, 'utf8');
    const generation = z.object({ routes: z.array(z.object({ name: z.string(), policies: z.record(z.string(), z.unknown()) }).passthrough()) }).passthrough().parse(JSON.parse(original));
    const route = generation.routes.find(r => r.name.startsWith('mcp-'))!;
    delete route.policies['extAuthz']; delete route.policies['authorization'];
    await writeFile(f.options.configFile, JSON.stringify(generation));
    await until(async () => { try { await f.gatewayAcknowledgements(); return false; } catch { return true; } });
    // Wait for the partial route to reach the transport: the old CEL route returns 403, the guarded transport returns 502.
    await until(async () => (await call(body.replace('"read"', '"unreviewed"'), { 'mcp-name': 'unreviewed' })).status === 502);
    expect(remote.calls).toHaveLength(6);
    await f.restart();
    for (const file of [f.options.configFile, f.options.usageFile]) {
      const text = await readFile(file, 'utf8');
      expect(text).not.toContain(f.headers.authorization); expect(text).not.toContain(f.headers['x-turn-token']);
      expect(text).not.toContain('forged');
    }
    const { sequence } = await mcpGrants(f.nats.store, 'test', 'fixture');
    const revokedAt = performance.now();
    await grantMcp(f.nats.store, f.binding, 'alice', 'fixture', { commandId: 'revoke-team', expectedSequence: sequence, granteeId: 'sales', granteeKind: 'team', action: 'revoke' });
    expect((await call()).status).toBe(403);
    expect(performance.now() - revokedAt).toBeLessThan(2000);
    const revoke = (await history(f.nats.store, grantStream('mcp_server', 'fixture'), 'test')).at(-1)!;
    await f.auth.handler.handle(revoke.event, f.db);
    expect((await call()).status).toBe(403);
    await grantMcp(f.nats.store, f.binding, 'alice', 'fixture', { commandId: 'restore-team', expectedSequence: revoke.sequence, granteeId: 'sales', granteeKind: 'team', action: 'give' });
    await f.auth.handler.handle((await history(f.nats.store, grantStream('mcp_server', 'fixture'), 'test')).at(-1)!.event, f.db);
    remote.setAnswers(['127.0.0.1']);
    expect((await call()).status).toBe(502);
    expect(remote.calls).toHaveLength(6);
    remote.setAnswers(['93.184.216.34']);
    await f.append('mcp-fixture', 'mcp.server_unpublished', { serverId: 'fixture', unpublishedBy: 'alice' });
    expect((await call()).status).toBe(403);
    const policy = await readToolPolicy(f.nats.store, 'test', 'fixture');
    await publishMcp(f.nats.store, f.binding, 'alice', 'fixture', { commandId: 'new-generation', expectedSequence: policy.sequence,
      schemaDigest: 'a'.repeat(64), accountMode: 'none', tools: [{ name: 'read', revision: 'b'.repeat(64), mode: 'allow', costCents: 0 }] });
    expect((await call()).status).toBe(403); // Applying cannot execute through the old route.
    const replacement = await publicationStatus(f.nats.store, 'test', 'fixture');
    await acknowledgeMcp(f.nats.store, 'test', 'fixture', replacement.changeRef!, replacement.digest!);
    expect((await call()).status).toBe(403); // Even an acknowledged replacement cannot authorise an old gateway generation.
    await f.append('mcp-fixture', 'mcp.tools_changed', { serverId: 'fixture', previousSchemaDigest: 'a'.repeat(64), newSchemaDigest: 'c'.repeat(64) });
    expect((await call()).status).toBe(403);
    expect(remote.calls).toHaveLength(6);
  } finally { await adapter.close(); await f.close(); await remote.close(); }
}, 40_000);
