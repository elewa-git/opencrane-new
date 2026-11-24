import { expect, it, vi } from 'vitest';
import { fixture } from './fixture.ts';

async function separateDecisionReads() {
  const setup = await fixture();
  try {
    await setup.stopDispatch();
    await setup.runtime.stop();
    const backendReads = vi.spyOn(setup.db, 'query');
    const head = await setup.nats.store.head();
    const request = { conversationId: 'conversation', turnId: 'turn', head,
      deadline: setup.nats.store.clock.now() + 2000 };
    const snapshot = await setup.identity.conversationHistory(request);
    expect(snapshot.conversation.some(isCreation)).toBe(true);
    expect(backendReads).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
    await setup.close();
  }
}
function isCreation(row: { event: { type: string } }) {
  return row.event.type === 'conversation.created';
}
it('keeps gateway index reads separate from the memory backend database handle',
  separateDecisionReads);

async function separateProjectionReads() {
  const setup = await fixture();
  try {
    await setup.stopDispatch();
    await setup.runtime.stop();
    const backendPositions = vi.spyOn(setup.nats.store, 'head');
    const backendQueries = vi.spyOn(setup.db, 'query');
    const backendLocks = vi.spyOn(setup.db, 'lock');
    await setup.append('conversation-other', 'agent.turn_started', {
      assistantId: 'other', conversationId: 'other', turnId: 'other-turn' });
    expect(backendPositions).not.toHaveBeenCalled();
    expect(backendQueries).not.toHaveBeenCalled();
    expect(backendLocks).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
    await setup.close();
  }
}
it('keeps projection worker positions separate from memory backend read probes',
  separateProjectionReads);
