import { expect, it } from 'vitest';
import { dirname } from 'node:path';
import { grantStream } from '@opencrane/authz';
import { catalogueEvidence, fixture, reviewCatalogue,
  toolEvidence } from '@opencrane/models/testing';
import { history, readToolPolicy } from '@opencrane/models';
import { memoryKeys, memoryProjection, memoryScopeId } from '@opencrane/projections';
import { buildServer } from '../src/server.ts';
import { installWorker } from '../src/integrations/install-worker.ts';
import { discoveryStatus } from '../src/integrations/registration.ts';
import { testAuthConfig } from './support/test-auth-config.ts';

const imageDigest = 'a'.repeat(64);
const memoryLocator = `registry.example.test/opencrane/server@sha256:${imageDigest}`;
const scopeId = memoryScopeId('test', 'person', 'alice');
const contracts = [undefined, { credentialMode: 'per_call', materialKind: 'per_call_lease' }];
const recallTool = toolEvidence({ name: 'recall', reviewed: true, costCents: 0 });
const memoryCatalogue = catalogueEvidence([recallTool]);

function memberId() {
  return Promise.resolve('alice');
}

async function reviewMemory(setup: Awaited<ReturnType<typeof fixture>>,
  credentialContract: (typeof contracts)[number]) {
  const registration = { serverId: 'memory', kind: 'hosted', locator: memoryLocator,
    registeredBy: 'alice', credentialContract };
  await setup.append('mcp-memory', 'mcp.server_registered', registration);
  const discovery = { serverId: 'memory', connectionId: 'server', accountMode: 'none',
    ...memoryCatalogue };
  await setup.append('mcp-memory', 'mcp.server_discovered', discovery);
  await reviewCatalogue(setup, 'memory');
  const mode = { serverId: 'memory', connectionId: 'server', toolName: 'recall',
    toolRevision: recallTool.revision, mode: 'allow', setBy: 'alice' };
  await setup.append('mcp-memory', 'mcp.tool_mode_set', mode);
  const publication = { serverId: 'memory', publishedBy: 'alice' };
  await setup.append('mcp-memory', 'mcp.server_published', publication);
  const resources = [['mcp_server', 'memory'], ['memory_read', scopeId]] as const;
  const grantees = [['member', 'alice'], ['assistant', 'assistant']] as const;
  for (const [resourceType, resourceId] of resources) {
    for (const [granteeKind, granteeId] of grantees) {
      const grant = { resourceType, resourceId, granteeKind, granteeId, grantedBy: 'alice' };
      const event = await setup.append(grantStream(resourceType, resourceId),
        'grant.given', grant);
      await setup.auth.handler.handle(event, setup.db);
    }
  }
}

async function keepsMemoryCallable(credentialContract: (typeof contracts)[number]) {
  const setup = await fixture(2000, 20000, false, 'gpt-6-luna', false, 'manual',
    'sales', 'restricted');
  const keyDirectory = dirname(setup.options.configFile);
  const keys = memoryKeys(keyDirectory);
  const projectionOptions = { decrypt: keys.decrypt };
  const projection = memoryProjection(projectionOptions);
  const memory = { silo: 'test', store: setup.nats.store, db: setup.db,
    binding: setup.binding, feed: { memberId }, identity: setup.identity, keyDirectory };
  const authConfig = testAuthConfig();
  const serverOptions = { memory };
  const app = buildServer(authConfig, serverOptions);
  const worker = installWorker(app, setup.nats.store, 'test');
  try {
    await setup.stopDispatch();
    await setup.runtime.stop();
    await reviewMemory(setup, credentialContract);
    await worker.discover('memory');
    const tool = recallTool;
    const status = await discoveryStatus(setup.nats.store, 'test', 'memory');
    expect(status).toMatchObject({ state: 'needs_input', reason: 'pending_review',
      inventory: { connectionId: 'server', tools: [tool] } });
    const policy = await readToolPolicy(setup.nats.store, 'test', 'memory');
    expect(policy).toMatchObject({ published: true, connectionId: 'server' });
    await setup.runner.initialise(projection);
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const upstream = new URL(address).host;
    const route = { serverId: 'memory', connectionId: 'server', upstream };
    setup.options.mcpRoutes.push(route);
    await setup.restart();
    const headers = { 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call',
      'mcp-name': 'recall' };
    const metadata = { threadId: 'thread', callId: 'memory-startup-regression',
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientCapabilities': {} };
    for (const method of ['server/discover', 'tools/list']) {
      const discoveryHeaders = { 'mcp-protocol-version': '2026-07-28',
        'mcp-method': method };
      const discoveryCall = { jsonrpc: '2.0', id: 1, method,
        params: { _meta: metadata } };
      const discovered = await setup.call(discoveryHeaders, discoveryCall, '/mcp/memory/server');
      expect(discovered.status, discovered.text).toBe(200);
      expect(discovered.text).toContain('"result"');
    }
    const call = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
      name: 'recall', arguments: { scopeId, query: '' }, _meta: metadata } };
    const response = await setup.call(headers, call, '/mcp/memory/server');
    expect(response.status).toBe(200);
    expect(response.text).toContain('"result"');
    const memoryRows = await history(setup.nats.store, 'mcp-memory', 'test');
    function isDispatchAdmission(row: (typeof memoryRows)[number]) {
      return row.event.type === 'mcp.dispatch_admitted';
    }
    const admissions = memoryRows.filter(isDispatchAdmission);
    expect(admissions).toHaveLength(0);
    const unsupported = { serverId: 'startup', kind: 'hosted', locator: memoryLocator,
      registeredBy: 'alice', credentialContract: { credentialMode: 'startup_lasting' } };
    await setup.append('mcp-startup', 'mcp.server_registered', unsupported);
    await worker.discover('startup');
    const refused = await discoveryStatus(setup.nats.store, 'test', 'startup');
    expect(refused).toMatchObject({ state: 'failed',
      reason: 'lasting_startup_secret_required' });
    const startupPolicy = await readToolPolicy(setup.nats.store, 'test', 'startup');
    expect(startupPolicy.published).toBe(false);
  } finally {
    await app.close();
    await setup.close();
  }
}

it.each(contracts)('keeps reviewed memory callable with contract %j and refuses lasting startup',
  keepsMemoryCallable);
