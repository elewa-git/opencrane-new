import { expect, it } from 'vitest';
import { turnTokenAudience } from '@opencrane/auth';
import { fixture } from './fixture.ts';

const sharingCases = [undefined, 'shared_only'] as const;

async function refusesMismatchedSharingClass(savedClass: typeof sharingCases[number]) {
  const setup = await fixture();
  try {
    const created = { conversationId: 'bound-chat', createdBy: 'alice', mode: 'agent_session',
      assistantId: 'assistant' };
    await setup.append('conversation-bound-chat', 'conversation.created', created);
    const start = { assistantId: 'assistant', computerId: 'computer',
      conversationId: 'bound-chat', turnId: 'bound-turn', threadId: 'bound-thread',
      requesterId: 'alice', task: 'chat_turn', payingGroupId: 'personal-default',
      executionMode: 'restricted', sharingClass: savedClass };
    await setup.append('computer-assistant', 'computer.turn_started', start);
    const claims = { ...setup.t, conversation: 'bound-chat', turn: 'bound-turn',
      thread: 'bound-thread', sharingClass: savedClass };
    const valid = await setup.sign(claims, turnTokenAudience);
    const validHeaders = { 'x-turn-token': valid, 'session-id': 'bound-thread' };
    const accepted = await setup.call(validHeaders);
    expect(accepted.status, accepted.text).toBe(200);
    await setup.settled();
    const reservations = setup.actor.state.reservations.length;
    const wrongClass = savedClass === undefined ? 'shared_only' : undefined;
    const mismatched = { ...claims, sharingClass: wrongClass,
      configuration: { tools: 'reviewed_mcp', sharingClass: undefined } };
    const signed = await setup.sign(mismatched, turnTokenAudience);
    const headers = { ...validHeaders, 'x-turn-token': signed };
    const refused = await setup.call(headers);
    expect(refused.status, refused.text).toBe(403);
    expect(setup.actor.state.reservations).toHaveLength(reservations);
    expect(setup.received()).toBe(1);
  } finally {
    await setup.close();
  }
}
it.each(sharingCases)('refuses signed claims that disagree with saved sharing class %s',
  refusesMismatchedSharingClass, 60_000);
