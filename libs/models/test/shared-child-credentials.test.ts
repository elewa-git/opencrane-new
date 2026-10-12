import { expect, it } from 'vitest';
import { turnTokenAudience } from '@opencrane/auth';
import { grantStream } from '@opencrane/authz';
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
      contextClass: 'shared_only' as const };
    const admitted = { ...input, model: undefined, computerId: 'computer', executionMode: 'restricted',
      payingGroupId: 'personal-default' };
    await setup.append('computer-assistant', 'computer.turn_started', admitted);
    const reportedStart = { conversationId: 'child', assistantId: 'assistant',
      turnId: 'child-turn', threadId: 'shared-thread', executionMode: 'restricted',
      contextClass: 'shared_only' };
    await setup.append('conversation-child', 'agent.turn_started', reportedStart);
    let previousId: string | undefined;
    for (const attempt of ['initial', 'renewed']) {
      const token = await setup.credentials.turn(input);
      const verified = await setup.tokens.verify(token.value, turnTokenAudience);
      expect(verified, attempt).toMatchObject({ contextClass: 'shared_only',
        conversation: 'child', turn: 'child-turn', thread: 'shared-thread' });
      expect(token.id).not.toBe(previousId);
      previousId = token.id;
      const headers = { ...setup.headers, 'x-turn-token': token.value,
        'session-id': 'shared-thread' };
      const checked = await setup.credentials.check(headers);
      expect(checked.turn['contextClass']).toBe('shared_only');
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
