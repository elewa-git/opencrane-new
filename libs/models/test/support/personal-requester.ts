import { randomUUID } from 'node:crypto';
import { grantStream } from '@opencrane/authz';
import { computerTokenAudience } from '@opencrane/auth';
import type { fixture } from '../fixture.ts';
import { oauthSelectionFixture, selectPersonalFixture } from './oauth-selection.ts';

type Fixture = Awaited<ReturnType<typeof fixture>>;

export async function personalRequester(setup: Fixture, originalBody: string,
  originalHeaders: Record<string, string>) {
  const joined = await setup.append('member-bob', 'member.joined', {
    memberId: 'bob', email: 'bob@example.test', displayName: 'Bob', role: 'member',
  });
  await setup.auth.handler.handle(joined, setup.db);
  await setup.append('assistant-bob-assistant', 'assistant.created', {
    assistantId: 'bob-assistant', ownerId: 'bob', kind: 'personal',
  });
  await setup.append('computer-bob-assistant', 'computer.claimed', {
    assistantId: 'bob-assistant', computerId: 'bob-computer',
    generation: 1, tokenId: 'token:bob',
  });
  await setup.append('computer-bob-assistant', 'computer.ready', {
    assistantId: 'bob-assistant', computerId: 'bob-computer', generation: 1, podUid: 'bob-pod',
  });
  await setup.append('conversation-bob-conversation', 'conversation.created', {
    conversationId: 'bob-conversation', assistantId: 'bob-assistant', createdBy: 'bob',
    mode: 'agent_session',
  });
  const threadId = randomUUID();
  const turn = { assistantId: 'bob-assistant', computerId: 'bob-computer',
    conversationId: 'bob-conversation', turnId: 'bob-turn', threadId, requesterId: 'bob',
    task: 'chat_turn', payingGroupId: 'personal-default' };
  await setup.append('conversation-bob-conversation', 'agent.turn_started', {
    conversationId: turn.conversationId, assistantId: turn.assistantId, turnId: turn.turnId,
  });
  await setup.append('computer-bob-assistant', 'computer.turn_started', turn);
  for (const [granteeKind, granteeId] of [['member', 'bob'], ['assistant', 'bob-assistant']]) {
    const granted = await setup.append(grantStream('mcp_server', 'fixture'), 'grant.given', {
      resourceType: 'mcp_server', resourceId: 'fixture', granteeKind, granteeId,
      grantedBy: 'alice',
    });
    await setup.auth.handler.handle(granted, setup.db);
  }
  function stageMaterial() {
    return Promise.resolve({ status: 'staged' as const,
      identity: { reference: 'bob-secret', uid: 'bob-uid', resourceVersion: '1' } });
  }
  const saved = await oauthSelectionFixture(setup.nats, 'bob', 'fixture', 'bob-profile',
    stageMaterial, { locator: 'https://mcp.example.test/mcp', grantedScopes: ['openid', 'write'] });
  const selectionRevision = await selectPersonalFixture(setup.nats, saved);
  const computer = { ...setup.c, assistant: 'bob-assistant', computer: 'bob-computer',
    jti: 'token:bob' };
  const computerToken = await setup.sign(computer, computerTokenAudience);
  const claims = { ...setup.t, assistant: 'bob-assistant', conversation: 'bob-conversation',
    requester: 'bob', delegation: ['bob'], computerTokenId: 'token:bob',
    thread: threadId, turn: 'bob-turn', personalSelections: [{ serverId: 'fixture',
      profileId: 'bob-profile', selectionRevision }] };
  const turnToken = await setup.sign(claims, 'decision-service');
  const headers = { ...originalHeaders, authorization: `Bearer ${computerToken}`,
    'x-turn-token': turnToken, 'session-id': threadId };
  const body = originalBody.replaceAll(originalHeaders['session-id']!, threadId);
  return { headers, body, saved };
}
