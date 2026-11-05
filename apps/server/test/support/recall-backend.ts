import { once } from 'node:events';
import { dirname } from 'node:path';
import { expect, onTestFinished, vi } from 'vitest';
import { grantStream } from '@opencrane/authz';
import { losslessJson } from '@opencrane/events/lossless-json';
import { decodeJwt } from 'jose';
import { readChatFacts } from '../../src/chat/chat-summary.ts';
import { history } from '@opencrane/models';
import { catalogueEvidence, fixture, reviewCatalogue, toolEvidence } from '@opencrane/models/testing';
import { memoryKeys, memoryProjection, memoryScopeId } from '@opencrane/projections';
import { fixture as bridgeFixture } from '../../../computer/test/bridge-gate-fixture.ts';
import { preflightFixture } from '../../../computer/test/private-recall-preflight-fixture.ts';
import { connectBridge } from '../../src/chat/bridge.ts';
import { assistantSnapshot, processConversation } from '../../src/chat/bridge-conversation.ts';
import { recallTool, registerMemoryMcp } from '../../src/memory/mcp.ts';
import Fastify from 'fastify';
import { initialQualificationFixture } from './initial-qualification.ts';
import { testAuthConfig } from './test-auth-config.ts';

export const scopeId = memoryScopeId('test', 'person', 'alice');
export const factText = 'My favourite walking destination is the winter garden.';
export const threadId = 'returned-native-1';

export async function recallBackend() {
  const setup = await fixture(2000, 20000, false, 'gpt-6-luna', false, 'manual',
    'sales', 'restricted');
  async function closeServices() {
    await setup.close();
  }
  onTestFinished(closeServices);
  await setup.stopDispatch();
  await setup.runtime.stop();
  const keyDirectory = dirname(setup.options.configFile);
  const keys = memoryKeys(keyDirectory);
  const projectionOptions = { decrypt: keys.decrypt };
  const projection = memoryProjection(projectionOptions);
  await setup.runner.initialise(projection);
  await governRecall(setup);
  async function write(memoryId: string, text = factText, pinned = false) {
    const identity = { silo: 'test', scopeId, scopeKind: 'person' as const,
      ownerId: 'alice', memoryId, revision: 1 };
    keys.provision(identity);
    const data = { schemaVersion: 1, scopeId, scopeKind: 'person', ownerId: 'alice',
      memoryId, revision: 1, kind: 'fact', pinned,
      expiresAt: null, sources: [], dependsOn: [], ...keys.encrypt(identity, text) };
    await setup.append(`scope-${scopeId}`, 'memory.written', data);
  }
  await write('garden');
  await setup.runner.run(projection);
  function memberId() {
    return Promise.resolve('alice');
  }
  const memory = { silo: 'test', store: setup.nats.store, db: setup.db,
    binding: setup.binding, feed: { memberId }, identity: setup.identity,
    dispatchGeneration: 'memory-instance', keyDirectory };
  const backend = await startBackend(setup, memory);
  const computer = await startComputer(setup, memory);
  async function admit(conversationId = 'chat', nativeThread = threadId) {
    return prepareChat(setup, memory, computer, conversationId, nativeThread);
  }
  const first = await admit();
  return { setup, ...computer, ...backend, ...first, admit, write, projection };
}

type MemoryOptions = NonNullable<Parameters<typeof registerMemoryMcp>[2]>;
type Setup = Awaited<ReturnType<typeof fixture>>;

async function startBackend(setup: Setup, memory: MemoryOptions) {
  const app = Fastify();
  const { deliveries, requests, wire, observeReply, observeRequest } = observeDeliveries(setup);
  app.addHook('onRequest', observeRequest);
  app.addHook('onSend', observeReply);
  registerMemoryMcp(app, testAuthConfig(), memory);
  async function closeBackend() {
    app.server.closeAllConnections();
    await app.close();
  }
  onTestFinished(closeBackend);
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const route = { serverId: 'memory', connectionId: 'server', upstream: new URL(address).host,
    generation: 'memory-instance', revisionHeader: 'x-opencrane-mcp-revision' as const };
  setup.options.mcpRoutes.push(route);
  await setup.restart('SIGKILL');
  return { deliveries, requests, wire };
}

function observeDeliveries(setup: Setup) {
  const deliveries: Awaited<ReturnType<typeof readChatFacts>>[] = [];
  const requests: Record<string, unknown>[] = [];
  const wire = { paths: [] as string[], results: 0 };
  function observeRequest(request: import('fastify').FastifyRequest,
    _reply: import('fastify').FastifyReply, done: () => void) {
    wire.paths.push(request.url);
    done();
  }
  async function observeReply(request: import('fastify').FastifyRequest,
    reply: import('fastify').FastifyReply, payload: unknown) {
    if (request.url.endsWith('/prepare') || reply.statusCode !== 200) {
      return payload;
    }
    wire.results += 1;
    const context = decodeJwt(String(request.headers['x-memory-context']));
    const facts = await readChatFacts(setup.nats.store, 'test',
      String(context['conversation']), String(context['turn']));
    deliveries.push(facts);
    const observed = { requester: context['requester'], thread: context['thread'],
      scopes: context['scopes'], conversation: context['conversation'], turn: context['turn'],
      authorizationPresent: request.headers.authorization !== undefined,
      turnPassPresent: request.headers['x-turn-token'] !== undefined,
      sessionPresent: request.headers['session-id'] !== undefined,
      requesterHeaderPresent: request.headers['x-requester-id'] !== undefined };
    requests.push(observed);
    return payload;
  }
  return { deliveries, requests, wire, observeReply, observeRequest };
}

async function startComputer(setup: Setup, memory: MemoryOptions) {
  const computer = await bridgeFixture(false);
  onTestFinished(computer.close);
  computer.socket.terminate();
  await once(computer.socket, 'close');
  const grants = new Map<string, { turnId: string; computer: string; token: string;
    expires: number; conversation: string }>();
  const native = await preflightFixture(`http://127.0.0.1:${setup.options.port}`, grants);
  onTestFinished(native.close);
  computer.driver.privateSession = native.openCurrent;
  Object.assign(computer.driver, native.driver);
  const computerPass = setup.headers.authorization.slice('Bearer '.length);
  const gateIdentity = { verifier: setup.tokens.jwks.keys[0], issuer: setup.identity.issuer,
    silo: 'test', computer: 'computer', assistant: 'assistant', generation: 1, podUid: 'pod' };
  function credential() {
    return { value: computerPass, expiresAt: Date.now() + 120_000, gateIdentity };
  }
  computer.driver.credential = credential;
  function grant(thread: string, conversation: string, token: string,
    expires: number, turnId: string) {
    if (token) {
      const value = { turnId, computer: computerPass, token, expires, conversation };
      grants.set(thread, value);
    } else {
      grants.delete(thread);
    }
    return Promise.resolve();
  }
  computer.driver.grant = grant;
  const deployment = await initialQualificationFixture();
  expect(deployment.result.result).toBe('PASS');
  const options = { ...memory, keys: setup.keys };
  const connection = { url: computer.socket.url, computerId: 'computer',
    assistantId: 'assistant', bearer: computerPass };
  const link = await connectBridge(options, connection, setup.tokens);
  async function closeBridge() {
    link.socket.terminate();
    await link.settled();
    vi.restoreAllMocks();
    setup.gatewayChild()?.kill('SIGKILL');
  }
  onTestFinished(closeBridge);
  return { native, link, grants };
}

function isTurnStart(method: string) {
  return method === 'turn/start';
}

async function prepareChat(setup: Setup, memory: MemoryOptions,
  computer: Awaited<ReturnType<typeof startComputer>>, conversationId: string, threadId: string) {
  const { native, link } = computer;
  const options = { ...memory, keys: setup.keys };
  const conversation = { conversationId, assistantId: 'assistant', createdBy: 'alice',
    mode: 'agent_session' as const, createdAt: new Date().toISOString(),
    assistantKind: 'personal' as const };
  const created = { conversationId, assistantId: 'assistant', createdBy: 'alice',
    mode: 'agent_session' };
  await setup.append(`conversation-${conversationId}`, 'conversation.created', created);
  setup.keys.provision('test', conversationId);
  const message = { conversationId, authorId: 'alice', authorKind: 'human',
    contentType: 'text', ...setup.keys.encrypt('test', conversationId, 'Recall my destination') };
  const posted = await setup.append(`conversation-${conversationId}`, 'message.posted', message);
  const turnId = posted.id;
  const admitted = { conversationId, turnId, requesterId: 'alice',
    assistantId: 'assistant', computerId: 'computer', threadId,
    task: 'chat_turn', executionMode: 'restricted', payingGroupId: 'personal-default' };
  await setup.append('computer-assistant', 'computer.turn_started', admitted);
  async function start() {
    const expectedStarts = native.received.filter(isTurnStart).length + 1;
    const rows = await history(setup.nats.store, 'computer-assistant', 'test');
    const assistant = assistantSnapshot(rows, 'personal', 'test');
    function connectedComputer() {
      return Promise.resolve({ ...link, connectionId: 1 });
    }
    await processConversation(options, setup.tokens, conversation, assistant,
      new Set(), connectedComputer);
    function dispatched() {
      expect(link.rejection).toBeUndefined();
      expect(native.received.filter(isTurnStart)).toHaveLength(expectedStarts);
    }
    const wait = { timeout: 10_000 };
    await vi.waitFor(dispatched, wait);
    await link.settled();
  }
  return { start, turnId };
}

async function governRecall(setup: Setup) {
  const registered = { serverId: 'memory', kind: 'hosted', registeredBy: 'alice',
    locator: `registry.example.test/memory@sha256:${'a'.repeat(64)}` };
  await setup.append('mcp-memory', 'mcp.server_registered', registered);
  const definition = JSON.stringify(recallTool);
  const metadata = { name: 'recall', reviewed: true, costCents: 0 };
  const tool = { ...toolEvidence(metadata), definition, revision: losslessJson(definition).digest };
  const catalogue = catalogueEvidence([tool]);
  const discovered = { serverId: 'memory', connectionId: 'server', accountMode: 'none',
    serverInfo: { name: 'OpenCrane memory', version: '1' }, ...catalogue };
  await setup.append('mcp-memory', 'mcp.server_discovered', discovered);
  await reviewCatalogue(setup, 'memory');
  const mode = { serverId: 'memory', connectionId: 'server', toolName: 'recall',
    toolRevision: tool.revision, mode: 'allow', setBy: 'alice' };
  await setup.append('mcp-memory', 'mcp.tool_mode_set', mode);
  const published = { serverId: 'memory', publishedBy: 'alice' };
  await setup.append('mcp-memory', 'mcp.server_published', published);
  const resources = [['memory_read', scopeId], ['mcp_server', 'memory']] as const;
  const grantees = [['member', 'alice'], ['assistant', 'assistant']] as const;
  for (const [resourceType, resourceId] of resources) {
    for (const [granteeKind, granteeId] of grantees) {
      const data = { resourceType, resourceId, granteeKind, granteeId, grantedBy: 'alice' };
      const event = await setup.append(grantStream(resourceType, resourceId), 'grant.given', data);
      await setup.auth.handler.handle(event, setup.db);
    }
  }
}
