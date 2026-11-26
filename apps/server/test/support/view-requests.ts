import { encodeSession, type AuthConfig } from '@opencrane/auth';
import type { viewFixture } from './view-fixture.ts';

type Fixture = Awaited<ReturnType<typeof viewFixture>>;

export function viewHeaders(config: AuthConfig, sub = 'alice') {
  const exp = Math.floor(Date.now() / 1000) + 300;
  const session = { sub, orgId: 'org-test', roles: [], authTime: 1, exp };
  const cookie = encodeSession(config, session);
  return { origin: new URL(config.redirectUri).origin, 'x-opencrane-view': '1',
    cookie: `${config.cookieName}=${cookie}` };
}

export async function teamViewChat({ append }: Fixture, applyAssistant = true) {
  await append('team-sales', 'team.created', {
    teamId: 'sales', name: 'Sales', createdBy: 'alice',
  }, true);
  await append('team-sales', 'team.member_added', {
    teamId: 'sales', memberId: 'alice', addedBy: 'alice',
  }, true);
  await append('team-sales', 'team.member_added', {
    teamId: 'sales', memberId: 'bob', addedBy: 'alice',
  }, true);
  const assistant = await append('assistant-team-sales', 'assistant.created', {
    assistantId: 'team-sales', ownerId: 'sales', kind: 'team', payingGroupId: 'sales',
  }, applyAssistant);
  const computer = { assistantId: 'team-sales', computerId: 'team-desktop', generation: 1 };
  await append('computer-team-sales', 'computer.claimed', {
    ...computer, sandboxUid: 'sandbox', tokenId: 'token:test',
  });
  await append('computer-team-sales', 'computer.ready', { ...computer, podUid: 'pod' });
  await append('conversation-team-session', 'conversation.created', {
    conversationId: 'team-session', assistantId: 'team-sales', createdBy: 'alice',
    mode: 'agent_session', payingGroupId: 'sales',
  }, true);
  return assistant;
}

export async function sharedChildChat(fixture: Fixture) {
  const { append, nats } = fixture;
  const parent = {
    conversationId: 'parent', createdBy: 'alice', mode: 'group',
    participantIds: ['alice', 'bob'],
  };
  const parentEvent = await append('conversation-parent', 'conversation.created', parent, true);
  const parentJoinPosition = await nats.store.head('conversation-parent');
  const parentJoin = { parentJoinEventId: parentEvent.id, parentJoinPosition };
  const initialJoins = [
    { participantId: 'alice', ...parentJoin },
    { participantId: 'bob', ...parentJoin },
  ];
  const source = await append('conversation-parent', 'message.posted', {
    conversationId: 'parent', authorId: 'alice', authorKind: 'human',
    utterance: 'Ask for help', contentType: 'text',
  });
  const sourcePosition = await nats.store.head('conversation-parent');
  const origin = { parentConversationId: 'parent', sourceMessageId: source.id, sourcePosition,
    intentEventId: 'intent', intentPosition: sourcePosition + 1, requestId: 'request',
    firstInputId: 'input' };
  const data = {
    conversationId: 'child', mode: 'agent_session', contextKind: 'shared_child',
    createdBy: 'alice', assistantId: 'assistant', payingGroupId: 'sales', initialJoins, origin,
  };
  await append('conversation-child', 'conversation.created', data, true);
}
