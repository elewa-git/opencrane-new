import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { grantStream } from '@opencrane/authz';
import { fixture } from './fixture.ts';

async function keepsConcurrentTokensSeparate() {
  const context = await fixture(2000, 20000, false, 'gpt-6-luna', true);
  try {
    const joined = await context.append('member-bob', 'member.joined', {
      memberId: 'bob', email: 'bob@example.test', displayName: 'Bob', role: 'member',
    });
    await context.auth.handler.handle(joined, context.db);
    await context.append('team-sales', 'team.member_added', {
      teamId: 'sales', memberId: 'bob', addedBy: 'alice',
    });
    const grant = await context.append(grantStream('model', 'gpt-6-luna'), 'grant.given', {
      resourceType: 'model', resourceId: 'gpt-6-luna', granteeId: 'bob',
      granteeKind: 'member', grantedBy: 'alice',
    });
    await context.auth.handler.handle(grant, context.db);
    await context.append('conversation-bob', 'conversation.created', {
      conversationId: 'bob', assistantId: 'assistant', createdBy: 'bob',
      mode: 'agent_session', payingGroupId: 'sales',
    });
    await context.append('computer-assistant', 'computer.turn_started', {
      assistantId: 'assistant', computerId: 'computer', conversationId: 'bob',
      turnId: 'bob-turn', threadId: 'bob-thread', requesterId: 'bob',
      task: 'chat_turn', payingGroupId: 'sales',
    });
    const bobToken = await context.credentials.turn({ assistantId: 'assistant',
      conversationId: 'bob', turnId: 'bob-turn', requesterId: 'bob', threadId: 'bob-thread',
      task: 'chat_turn', model: 'gpt-6-luna' });
    expect(bobToken.value).not.toBe(context.headers['x-turn-token']);
    const bobHeaders = { 'x-turn-token': bobToken.value, 'session-id': 'bob-thread' };
    const aliceCall = context.call();
    const bobCall = context.call(bobHeaders);
    const responses = await Promise.all([aliceCall, bobCall]);
    function status(response: typeof responses[number]) {
      return response.status;
    }
    expect(responses.map(status)).toEqual([200, 200]);
    expect(context.received()).toBe(2);
    await context.settled();
    expect((await context.call({ 'session-id': 'bob-thread' })).status).toBe(403);
    expect((await context.call({ ...bobHeaders, 'session-id': 'thread' })).status).toBe(403);
    const forged = await context.sign({ ...context.t, requester: 'bob', delegation: ['bob'] },
      'decision-service');
    expect((await context.call({ 'x-turn-token': forged })).status).toBe(403);
    expect(context.received()).toBe(2);
    function charge(row: typeof context.actor.state.reservations[number]) {
      return { requester: row.call.requesterId, payer: row.call.payingGroupId };
    }
    const charges = context.actor.state.reservations.map(charge);
    function compareCharges(first: typeof charges[number], second: typeof charges[number]) {
      return first.requester.localeCompare(second.requester);
    }
    charges.sort(compareCharges);
    expect(charges).toEqual([
      { requester: 'alice', payer: 'sales' }, { requester: 'bob', payer: 'sales' },
    ]);
    await context.append('computer-assistant', 'computer.turn_closed', {
      assistantId: 'assistant', computerId: 'computer', conversationId: 'bob',
      turnId: 'bob-turn', threadId: 'bob-thread', requesterId: 'bob',
      task: 'chat_turn', payingGroupId: 'sales', status: 'completed',
    });
    expect((await context.call(bobHeaders)).status).toBe(403);
    expect(context.received()).toBe(2);
    await context.append('team-support', 'team.created', {
      teamId: 'support', name: 'Support', createdBy: 'alice',
    });
    await context.append('team-support', 'team.member_added', {
      teamId: 'support', memberId: 'bob', addedBy: 'alice',
    });
    await context.append('computer-assistant', 'computer.turn_started', {
      assistantId: 'assistant', computerId: 'computer', conversationId: 'bob',
      turnId: 'changed-payer', threadId: 'changed-payer-thread', requesterId: 'bob',
      task: 'chat_turn', payingGroupId: 'support',
    });
    const changed = await context.credentials.turn({ assistantId: 'assistant',
      conversationId: 'bob', turnId: 'changed-payer', requesterId: 'bob',
      threadId: 'changed-payer-thread', task: 'chat_turn', model: 'gpt-6-luna' });
    const changedHeaders = { 'x-turn-token': changed.value, 'session-id': 'changed-payer-thread' };
    expect((await context.call(changedHeaders)).status).toBe(403);
    expect(context.received()).toBe(2);
  } finally {
    await context.close();
  }
}
it('two simultaneous members reach the recording gateway with distinct tokens and swapped tokens deny',
  keepsConcurrentTokensSeparate, 60_000);

async function fencesGroupGrantWithMatchingAssistantId() {
  const setup = await fixture(2000, 20000, false, 'gpt-6-luna', true);
  const originalAppend = setup.nats.store.append.bind(setup.nats.store);
  try {
    const revoked = await setup.append(grantStream('model', 'gpt-6-luna'), 'grant.revoked', {
      resourceType: 'model', resourceId: 'gpt-6-luna', granteeId: 'alice', revokedBy: 'alice',
    });
    await setup.auth.handler.handle(revoked, setup.db);
    await setup.append('team-assistant', 'team.created', {
      teamId: 'assistant', name: 'Model users', createdBy: 'alice',
    });
    await setup.append('team-assistant', 'team.member_added', {
      teamId: 'assistant', memberId: 'alice', addedBy: 'alice',
    });
    for (const granteeKind of ['team', 'assistant']) {
      const given = await setup.append(grantStream('model', 'gpt-6-luna'), 'grant.given', {
        resourceType: 'model', resourceId: 'gpt-6-luna', granteeId: 'assistant',
        granteeKind, grantedBy: 'alice',
      });
      await setup.auth.handler.handle(given, setup.db);
    }
    async function removeAfterAllow(command: Parameters<typeof originalAppend>[0]) {
      const result = await originalAppend(command);
      const allowAudit = z.object({
        type: z.literal('decision.recorded'), data: z.object({ outcome: z.literal('allow') }),
      });
      if (allowAudit.safeParse(command.event).success) {
        await setup.append('team-assistant', 'team.member_removed', {
          teamId: 'assistant', memberId: 'alice', removedBy: 'alice',
        });
      }
      return result;
    }
    const race = vi.spyOn(setup.nats.store, 'append').mockImplementation(removeAfterAllow);
    try {
      expect((await setup.call()).status).toBe(503);
      expect(setup.received()).toBe(0);
      expect(setup.actor.state.reservations[0]?.settledCents).toBe(0);
    } finally {
      race.mockRestore();
    }
  } finally {
    await setup.close();
  }
}
it('fences a group resource grant even when an assistant grant with the same id follows it',
  fencesGroupGrantWithMatchingAssistantId, 60_000);

async function refusesMissingOrDifferentAssistantPayer() {
  for (const assistantPayer of [null, 'support']) {
    const setup = await fixture(2000, 20000, false, 'gpt-6-luna', true, 'manual', assistantPayer);
    try {
      expect((await setup.call()).status).toBe(403);
      expect(setup.received()).toBe(0);
    } finally {
      await setup.close();
    }
  }
}
it('refuses a team model call when its assistant has no payer or a different payer',
  refusesMissingOrDifferentAssistantPayer, 60_000);
