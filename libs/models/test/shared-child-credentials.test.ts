import { expect, it } from 'vitest';
import { turnTokenAudience } from '@opencrane/auth';
import { fixture } from './fixture.ts';

async function signsAndRenewsSharedPass() {
  const setup = await fixture();
  try {
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
      const request = { method: 'POST', headers, body: '{}' };
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
