import { expect, it, vi } from 'vitest';
import { turnTokenAudience } from '@opencrane/auth';
import { grantStream } from '@opencrane/authz';
import { memoryScopeId } from '@opencrane/projections';
import { parseMemoryRequest } from '../src/mcp.ts';
import { verifyMemoryContext } from '../src/memory-context.ts';
import { catalogueEvidence, fixture, reviewCatalogue, toolEvidence } from './fixture.ts';

async function allowFixtureTool(setup: Awaited<ReturnType<typeof fixture>>) {
  const tool = toolEvidence({ name: 'read', reviewed: true, costCents: 0 });
  const catalogue = catalogueEvidence([tool]);
  const registration = { serverId: 'fixture', kind: 'remote',
    locator: 'https://fixture.example.test/mcp', registeredBy: 'alice' };
  await setup.append('mcp-fixture', 'mcp.server_registered', registration);
  const discovery = { serverId: 'fixture', connectionId: 'installed', accountMode: 'none',
    ...catalogue };
  await setup.append('mcp-fixture', 'mcp.server_discovered', discovery);
  await reviewCatalogue(setup);
  const mode = { serverId: 'fixture', connectionId: 'installed', toolName: 'read',
    toolRevision: tool.revision, mode: 'allow', setBy: 'alice' };
  await setup.append('mcp-fixture', 'mcp.tool_mode_set', mode);
  const publication = { serverId: 'fixture', publishedBy: 'alice' };
  await setup.append('mcp-fixture', 'mcp.server_published', publication);
  for (const [granteeId, granteeKind] of [['alice', 'member'], ['assistant', 'assistant']]) {
    const grant = { resourceType: 'mcp_server', resourceId: 'fixture',
      granteeId, granteeKind, grantedBy: 'alice' };
    const event = await setup.append(grantStream('mcp_server', 'fixture'), 'grant.given', grant);
    await setup.auth.handler.handle(event, setup.db);
  }
}

async function signsAndRenewsSharedPass() {
  const setup = await fixture();
  try {
    await allowFixtureTool(setup);
    const created = { conversationId: 'child', createdBy: 'alice', mode: 'agent_session',
      contextKind: 'shared_child', assistantId: 'assistant', payingGroupId: 'sales',
      initialJoins: [{ participantId: 'alice', parentJoinEventId: 'join', parentJoinPosition: 1 }],
      origin: { parentConversationId: 'parent', sourceMessageId: 'source', sourcePosition: 2,
        intentEventId: 'intent', intentPosition: 3, requestId: 'request', firstInputId: 'child-turn' } };
    await setup.append('conversation-child', 'conversation.created', created);
    const input = { assistantId: 'assistant', conversationId: 'child', turnId: 'child-turn',
      requesterId: 'alice', threadId: 'shared-thread', task: 'chat_turn', model: 'gpt-6-luna',
      sharingClass: 'shared_only' as const };
    const admitted = { ...input, model: undefined, computerId: 'computer', executionMode: 'restricted',
      payingGroupId: 'personal-default' };
    await setup.append('computer-assistant', 'computer.turn_started', admitted);
    const reportedStart = { conversationId: 'child', assistantId: 'assistant',
      turnId: 'child-turn', threadId: 'shared-thread', executionMode: 'restricted',
      sharingClass: 'shared_only' };
    await setup.append('conversation-child', 'agent.turn_started', reportedStart);
    let previousId: string | undefined;
    for (const attempt of ['initial', 'renewed']) {
      const token = await setup.credentials.turn(input);
      const verified = await setup.tokens.verify(token.value, turnTokenAudience);
      expect(verified, attempt).toMatchObject({ sharingClass: 'shared_only',
        conversation: 'child', turn: 'child-turn', thread: 'shared-thread' });
      expect(token.id).not.toBe(previousId);
      previousId = token.id;
      const headers = { ...setup.headers, 'x-turn-token': token.value,
        'session-id': 'shared-thread' };
      const checked = await setup.credentials.check(headers);
      expect(checked.turn['sharingClass']).toBe('shared_only');
      const toolHeaders = { ...headers, 'mcp-protocol-version': '2026-07-28',
        'mcp-method': 'tools/call', 'mcp-name': 'read' };
      const body = { jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'read', arguments: {},
          _meta: { threadId: 'shared-thread', callId: `shared-${attempt}` } } };
      const request = { method: 'POST', headers: toolHeaders, body: JSON.stringify(body) };
      const reservationsBeforeTools = setup.actor.state.reservations.length;
      for (const path of ['/authorize/mcp/fixture/installed', '/authorize/mcp/memory/server']) {
        const response = await fetch(`${setup.options.decisionUrl}${path}`, request);
        expect(response.status, attempt).toBe(403);
        expect(response.headers.get('x-opencrane-mcp-permit')).toBeNull();
        expect(setup.actor.state.reservations).toHaveLength(reservationsBeforeTools);
      }
      const model = await setup.call(headers);
      expect(model.status, model.text).toBe(200);
      await setup.settled();
    }
    expect(setup.received()).toBe(2);
  } finally {
    await setup.close();
  }
}
it('signs and renews shared child passes for model calls while refusing MCP and memory',
  signsAndRenewsSharedPass, 60_000);

type ToolFixture = Awaited<ReturnType<typeof fixture>>;

const personalScopeId = memoryScopeId('test', 'person', 'alice');
const toolRoutes = [
  { name: 'MCP', path: '/authorize/mcp/fixture/installed', toolName: 'read', arguments: {} },
  { name: 'memory', path: '/authorize/mcp/memory/server', toolName: 'remember',
    arguments: { scopeId: personalScopeId, commandId: 'remember-fixture', text: 'A test fact',
      kind: 'fact', pinned: false, expiresAt: null, sources: [], dependsOn: [],
      recallProof: 'fixture-recall-proof' } },
] as const;
type ToolRoute = typeof toolRoutes[number];

async function allowMemoryFixtureTool(setup: ToolFixture) {
  const tool = toolEvidence({ name: 'remember', reviewed: true, costCents: 0 });
  const catalogue = catalogueEvidence([tool]);
  const registration = { serverId: 'memory', kind: 'hosted',
    locator: `registry.example.test/opencrane/server@sha256:${'a'.repeat(64)}`,
    registeredBy: 'alice' };
  await setup.append('mcp-memory', 'mcp.server_registered', registration);
  const discovery = { serverId: 'memory', connectionId: 'server', accountMode: 'none',
    ...catalogue };
  await setup.append('mcp-memory', 'mcp.server_discovered', discovery);
  await reviewCatalogue(setup, 'memory');
  const mode = { serverId: 'memory', connectionId: 'server', toolName: 'remember',
    toolRevision: tool.revision, mode: 'allow', setBy: 'alice' };
  await setup.append('mcp-memory', 'mcp.tool_mode_set', mode);
  const publication = { serverId: 'memory', publishedBy: 'alice' };
  await setup.append('mcp-memory', 'mcp.server_published', publication);
  for (const resourceType of ['mcp_server', 'memory_write']) {
    const resourceId = resourceType === 'mcp_server' ? 'memory' : personalScopeId;
    for (const [granteeId, granteeKind] of [['alice', 'member'], ['assistant', 'assistant']]) {
      const grant = { resourceType, resourceId, granteeId, granteeKind, grantedBy: 'alice' };
      const event = await setup.append(grantStream(resourceType, resourceId), 'grant.given', grant);
      await setup.auth.handler.handle(event, setup.db);
    }
  }
  const route = { serverId: 'memory', connectionId: 'server',
    upstream: setup.options.mcpRoutes[0]!.upstream, generation: 'instance-1',
    revisionHeader: 'x-opencrane-mcp-revision' as const };
  setup.options.mcpRoutes.push(route);
}

function validToolRequest(route: ToolRoute, threadId: string, callId: string) {
  const metadata = { threadId, callId,
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientCapabilities': {} };
  const body = { jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: route.toolName, arguments: route.arguments, _meta: metadata } };
  return JSON.stringify(body);
}

function toolRequestHeaders(route: ToolRoute, headers: Record<string, string>) {
  return { ...headers, 'mcp-protocol-version': '2026-07-28',
    'mcp-method': 'tools/call', 'mcp-name': route.toolName };
}

async function admitPrivateToolControl(setup: ToolFixture, route: ToolRoute) {
  const body = validToolRequest(route, 'thread', 'private-control');
  const headers = toolRequestHeaders(route, setup.headers);
  const request = { method: 'POST', headers, body };
  const response = await fetch(`${setup.options.decisionUrl}${route.path}`, request);
  expect(response.status, await response.text()).toBe(200);
  const permit = response.headers.get('x-opencrane-mcp-permit');
  expect(permit).toBeTruthy();
  const dispatchPath = route.path.replace('/authorize/', '/dispatch/');
  const dispatchHeaders = { 'content-type': 'application/json',
    'x-opencrane-mcp-permit': permit! };
  const dispatchRequest = { method: 'POST', headers: dispatchHeaders, body };
  const dispatched = await fetch(`${setup.options.decisionUrl}${dispatchPath}`, dispatchRequest);
  expect(dispatched.status, await dispatched.text()).toBe(200);
  expect(setup.received()).toBe(1);
}

async function startSharedToolTurn(setup: ToolFixture) {
  const created = { conversationId: 'tool-child', createdBy: 'alice', mode: 'agent_session',
    contextKind: 'shared_child', assistantId: 'assistant', payingGroupId: 'sales',
    initialJoins: [{ participantId: 'alice', parentJoinEventId: 'join', parentJoinPosition: 1 }],
    origin: { parentConversationId: 'parent', sourceMessageId: 'source', sourcePosition: 2,
      intentEventId: 'intent', intentPosition: 3, requestId: 'request', firstInputId: 'tool-turn' } };
  await setup.append('conversation-tool-child', 'conversation.created', created);
  const input = { assistantId: 'assistant', conversationId: 'tool-child', turnId: 'tool-turn',
    requesterId: 'alice', threadId: 'tool-thread', task: 'chat_turn', model: 'gpt-6-luna',
    sharingClass: 'shared_only' as const };
  const admitted = { ...input, model: undefined, computerId: 'computer', executionMode: 'restricted',
    payingGroupId: 'personal-default' };
  await setup.append('computer-assistant', 'computer.turn_started', admitted);
  const reportedStart = { conversationId: 'tool-child', assistantId: 'assistant',
    turnId: 'tool-turn', threadId: 'tool-thread', executionMode: 'restricted',
    sharingClass: 'shared_only' };
  await setup.append('conversation-tool-child', 'agent.turn_started', reportedStart);
  return input;
}

async function refusesValidSharedToolCall(route: ToolRoute) {
  const setup = await fixture(2000, 20000, false, 'gpt-6-luna', false, 'manual', 'sales',
    'restricted');
  const memorySigner = vi.spyOn(setup.tokens, 'memoryContext');
  try {
    await allowFixtureTool(setup);
    await allowMemoryFixtureTool(setup);
    await admitPrivateToolControl(setup, route);
    if (route.name === 'memory') {
      expect(memorySigner).toHaveBeenCalledTimes(1);
      const signed: unknown = await memorySigner.mock.results[0]!.value;
      if (typeof signed !== 'string') throw new Error('Memory pass was not signed');
      const body = validToolRequest(route, 'thread', 'private-control');
      const headers = toolRequestHeaders(route, setup.headers);
      const parsed = parseMemoryRequest(body, headers);
      const claims = await verifyMemoryContext(signed, setup.identity, parsed);
      expect(claims).toMatchObject({ conversation: 'conversation', turn: 'turn',
        operation: 'remember', scopes: [personalScopeId], contentAccess: 'private' });
    }
    memorySigner.mockClear();
    const input = await startSharedToolTurn(setup);
    const spendingBefore = structuredClone(setup.actor.state);
    for (const attempt of ['initial', 'renewed']) {
      const token = await setup.credentials.turn(input);
      const turnHeaders = { ...setup.headers, 'x-turn-token': token.value,
        'session-id': input.threadId };
      const headers = toolRequestHeaders(route, turnHeaders);
      const body = validToolRequest(route, input.threadId, `shared-${attempt}`);
      const request = { method: 'POST', headers, body };
      const response = await fetch(`${setup.options.decisionUrl}${route.path}`, request);
      expect.soft(response.status, await response.text()).toBe(403);
      expect.soft(response.headers.get('x-opencrane-mcp-permit')).toBeNull();
      expect.soft(response.headers.get('x-memory-context')).toBeNull();
      expect.soft(memorySigner).not.toHaveBeenCalled();
      expect.soft(setup.actor.state).toEqual(spendingBefore);
      expect.soft(setup.received()).toBe(1);
    }
  } finally {
    memorySigner.mockRestore();
    await setup.close();
  }
}
it.each(toolRoutes)('refuses valid shared-child $name calls after a successful private control',
  refusesValidSharedToolCall, 60_000);
