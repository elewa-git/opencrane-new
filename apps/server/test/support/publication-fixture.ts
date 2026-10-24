import { once } from 'node:events';
import { WebSocketServer, type WebSocket } from 'ws';
import { encodeSession } from '@opencrane/auth';
import { grantStream } from '@opencrane/authz';
import { freePort } from '@opencrane/event-store/testing';
import { toolReviewDigest } from '@opencrane/events/mcp-catalogue';
import { gatewayDelivery, history, prepareGatewayConfiguration, readToolPolicy }
  from '@opencrane/models';
import { fixture } from '@opencrane/models/testing';
import { connectMcpCatalogue, groups, members, mcpCatalogue } from '@opencrane/projections';
import { expect, onTestFinished } from 'vitest';
import { z } from 'zod';
import { buildServer } from '../../src/server.ts';
import { discoverInventory } from '../../src/integrations/inventory.ts';
import { connectBridge } from '../../src/chat/bridge.ts';
import { assistantSnapshot, processConversation, type AgentSession }
  from '../../src/chat/bridge-conversation.ts';
import { testAuthConfig } from './test-auth-config.ts';

type Setup = Awaited<ReturnType<typeof fixture>>;
const serverId = 'fixture';
const path = `/api/org/integrations/${serverId}`;

function discoveryReply(method: string) {
  const cache = { resultType: 'complete', ttlMs: 300_000, cacheScope: 'public' };
  if (method === 'server/discover') {
    const experimental = { 'io.opencrane/expectedRevision': {} };
    const result = { ...cache, supportedVersions: ['2026-07-28'],
      capabilities: { tools: {}, experimental },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'Demo', version: '1' } } };
    return Promise.resolve(JSON.stringify(result));
  }
  function declaration(name: string) {
    const review = { action: 'Use a demo quote', consequence: 'Use synthetic data only',
      targetArgument: 'quoteId', fields: ['quoteId'], stepUp: false };
    return { name, inputSchema: { type: 'object' },
      annotations: { readOnlyHint: name === 'read', destructiveHint: name === 'write' },
      _meta: { 'io.opencrane/costCents': 0, 'io.opencrane/review': review } };
  }
  const tools = ['read', 'write'].map(declaration);
  return Promise.resolve(JSON.stringify({ ...cache, tools }));
}

export async function publicationFixture() {
  const setup = await fixture();
  onTestFinished(setup.close.bind(setup));
  const projections = [members, groups, mcpCatalogue];
  for (const projection of projections) {
    await setup.runner.initialise(projection);
  }
  const catalogue = connectMcpCatalogue(setup.databaseUrl!);
  onTestFinished(catalogue.close);
  const { post, status } = publicationApi(setup, catalogue);
  async function project() {
    for (const projection of projections) {
      await setup.runner.run(projection);
    }
  }
  async function policy() {
    return readToolPolicy(setup.nats.store, 'test', serverId);
  }
  async function review(block = false) {
    const current = await policy();
    function choice(tool: NonNullable<NonNullable<typeof current.catalogue>['tools']>[number]) {
      let mode = 'ask';
      if (tool.name === 'read') {
        mode = 'allow';
      }
      if (block) {
        mode = 'block';
      }
      return { name: tool.name, revision: tool.revision,
        reviewDigest: toolReviewDigest(tool), mode };
    }
    const tools = current.catalogue!.tools!.map(choice);
    const payload = { expectedSequence: current.sequence, policyRevision: current.policyRevision,
      catalogueDigest: current.catalogue!.schemaDigest, connectionId: 'installed',
      accountMode: 'none', tools };
    await post('/review', payload);
  }
  async function publish(expected = 200) {
    const current = await policy();
    const payload = { expectedSequence: current.sequence,
      reviewRevision: current.reviewRevision ?? 1 };
    const commandId = await post('/publication', payload, expected);
    if (expected !== 200) {
      return undefined;
    }
    return prepareGatewayConfiguration(setup.nats.store, 'test', serverId, commandId);
  }
  async function grant(granteeKind: 'member' | 'assistant', action = 'grant') {
    const expectedSequence = await setup.nats.store.head(grantStream('mcp_server', 'fixture'));
    const granteeId = granteeKind === 'member' ? 'alice' : 'assistant';
    const payload = { granteeKind, granteeId, action, expectedSequence };
    await post('/access/changes', payload);
    const rows = await history(setup.nats.store, grantStream('mcp_server', 'fixture'), 'test');
    await setup.auth.handler.handle(rows.at(-1)!.event, setup.db);
    await project();
  }
  await registerFixture(setup);
  await project();
  const delivery = await publicationDelivery(setup);
  async function acknowledge(record: Awaited<ReturnType<typeof prepareGatewayConfiguration>>) {
    await delivery.deliver(record);
    const polling = { timeout: 5000 };
    await expect.poll(delivery.observe, polling).not.toBeNull();
    setup.dispatchOptions.acknowledged = delivery.acknowledged;
  }
  const turn = bridgeTurn.bind(undefined, setup, catalogue);
  return { setup, catalogue, policy, review, publish, grant, status, post, project,
    delivery, acknowledge, turn };
}

function publicationApi(setup: Setup, catalogue: ReturnType<typeof connectMcpCatalogue>) {
  const config = testAuthConfig({ expectedOrgId: 'org-test' });
  function memberId() {
    return Promise.resolve('alice');
  }
  const access = { silo: 'test', store: setup.nats.store, db: setup.db,
    binding: setup.binding, feed: { memberId } };
  const integrations = { ...access, modelDb: setup.db, catalogue };
  const app = buildServer(config, { integrations, modelAccess: access, groups: access });
  async function closeApp() {
    await app.close();
  }
  onTestFinished(closeApp);
  const session = { sub: 'alice', orgId: 'org-test', roles: [],
    authTime: 1790856000, exp: 2000000000 };
  const headers = { origin: 'https://app.example.test',
    cookie: `${config.cookieName}=${encodeSession(config, session)}` };
  let counter = 0;
  async function post(suffix: string, payload: Record<string, unknown>, expected = 200) {
    const commandId = `publication-${++counter}`;
    const request = { method: 'POST' as const, url: `${path}${suffix}`, headers,
      payload: { ...payload, commandId } };
    const response = await app.inject(request);
    expect(response.statusCode, response.body).toBe(expected);
    return commandId;
  }
  async function status() {
    const response = await app.inject({ url: `${path}/publication`, headers });
    expect(response.statusCode, response.body).toBe(200);
    return response.json<unknown>();
  }
  return { post, status };
}

async function registerFixture(setup: Setup) {
  const registration = { serverId, kind: 'remote',
    locator: 'https://fixture.example.test/mcp', registeredBy: 'alice' };
  await setup.append('mcp-fixture', 'mcp.server_registered', registration);
  const inventory = await discoverInventory(discoveryReply);
  const discovered = { ...inventory, serverId, connectionId: 'installed', accountMode: 'none' };
  await setup.append('mcp-fixture', 'mcp.server_discovered', discovered);
}

async function publicationDelivery(setup: Setup) {
  const controlPort = await freePort();
  const deliveryOptions = { db: setup.db, mode: 'live' as const, store: setup.nats.store,
    silo: 'test', child: setup.gatewayChild()!, configFile: setup.options.configFile,
    controlPort, settings: setup.options };
  const delivery = gatewayDelivery(deliveryOptions);
  onTestFinished(delivery.close);
  return delivery;
}

async function bridgeTurn(setup: Setup, catalogue: ReturnType<typeof connectMcpCatalogue>) {
  const conversationId = `chat-${Date.now()}`;
  const created = { conversationId, assistantId: 'assistant', createdBy: 'alice',
    mode: 'agent_session' as const };
  await setup.append(`conversation-${conversationId}`, 'conversation.created', created);
  setup.keys.provision('test', conversationId);
  const encrypted = setup.keys.encrypt('test', conversationId, 'Read the demo quote');
  const message = { conversationId, authorId: 'alice', authorKind: 'human',
    contentType: 'text', ...encrypted };
  await setup.append(`conversation-${conversationId}`, 'message.posted', message);
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  function support(headers: string[]) {
    headers.push('x-opencrane-approval-waiting: true');
  }
  server.on('headers', support);
  const frames: unknown[] = [];
  function connected(socket: WebSocket) {
    function receive(bytes: Buffer) {
      const frame = z.record(z.string(), z.unknown()).parse(JSON.parse(bytes.toString()));
      if (frame['type'] === 'turn') {
        frames.push(frame);
      }
    }
    socket.on('message', receive);
  }
  server.on('connection', connected);
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Missing bridge port');
  }
  const options = { silo: 'test', store: setup.nats.store, keys: setup.keys,
    db: setup.db, binding: setup.binding, catalogue };
  const input = { url: `ws://127.0.0.1:${address.port}`, computerId: 'computer',
    assistantId: 'assistant', bearer: 'fixture' };
  const link = await connectBridge(options, input);
  try {
    function connection() {
      const connected = { ...link, connectionId: 1 };
      return Promise.resolve(connected);
    }
    const conversation: AgentSession = { ...created, assistantKind: 'personal',
      createdAt: new Date().toISOString() };
    const computers = await history(setup.nats.store, 'computer-assistant', 'test');
    const assistant = assistantSnapshot(computers, 'personal', 'test');
    await processConversation(options, setup.tokens, conversation, assistant,
      new Set(), connection);
    function received() {
      expect(frames).toHaveLength(1);
    }
    await expect.poll(received).toBeUndefined();
    return z.record(z.string(), z.unknown()).parse(frames[0]);
  } finally {
    link.socket.terminate();
    for (const socket of server.clients) {
      socket.terminate();
    }
    const closed = once(server, 'close');
    server.close();
    await closed;
  }
}
