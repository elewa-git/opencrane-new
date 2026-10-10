import { expect, it } from 'vitest';
import { getEventDefinition } from '@opencrane/events';
import { fixture } from './fixture.ts';

async function keepsDelegationDisabled() {
  const context = await fixture();
  try {
    await context.append('delegation-legacy', 'delegation.started', {
      delegationId: 'legacy', parentComputerId: 'computer', childComputerId: 'child',
      rootBudgetId: 'budget-test' });
    const childClaims = { ...context.t, turn: 'child-turn', thread: 'child-thread' };
    const legacyToken = await context.sign(childClaims, 'decision-service');
    const legacyHeaders = { 'x-turn-token': legacyToken, 'session-id': 'child-thread' };
    expect((await context.call(legacyHeaders)).status).toBe(403);
    const definition = getEventDefinition('delegation.started');
    const value: unknown = definition?.example;
    if (typeof value !== 'object' || value === null) throw new Error('Missing modern example');
    const native: Record<string, unknown> = { ...value, task: 'native_descendant',
      conversationId: 'conversation', payingGroupId: 'personal-default' };
    delete native['version'];
    delete native['computerAdmission'];
    const nativeStart = { id: 'native-start', commandId: 'native-start',
      type: 'computer.turn_started', subject: 'computer-assistant', data: native,
      silo: 'test', source: 'opencrane-server', time: '2026-10-10T10:00:00Z',
      principal: { kind: 'system' as const, id: 'opencrane-server' }, correlation: {} };
    const records = [nativeStart];
    await context.nats.seed(records);
    const nativeClaims = { ...childClaims, task: 'native_descendant' };
    const nativeToken = await context.sign(nativeClaims, 'decision-service');
    const nativeHeaders = { 'x-turn-token': nativeToken, 'session-id': 'child-thread' };
    expect((await context.call(nativeHeaders)).status).toBe(403);
    const input = { assistantId: 'assistant', conversationId: 'chat', turnId: 'child-turn',
      threadId: 'child-thread', requesterId: 'alice', task: 'native_descendant',
      model: 'gpt-6-luna' };
    await expect(context.credentials.turn(input)).rejects.toThrow('Native delegation is disabled');
    expect(context.received()).toBe(0);
    expect(context.actor.state.reservations).toHaveLength(0);
  } finally {
    await context.close();
  }
}
it('grants no call authority to legacy replay or recorded native tasks', keepsDelegationDisabled);
