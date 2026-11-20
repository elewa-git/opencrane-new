import { expect, it, vi } from 'vitest';
import { manualClock, natsFixture } from '@opencrane/event-store/testing';
import { readStreamSummary, type StoredEvent } from '@opencrane/event-store';
import { caughtUpConversation } from '../src/decision-conversation-catchup.ts';
import { decisionChatSummary } from '../src/decision-summary.ts';
import { envelope } from '../src/actor.ts';

function copy(rows: StoredEvent[]) {
  return [...rows];
}

async function catchesUpOnceAndKeepsCapturedPosition() {
  const fixture = await natsFixture();
  const resume = Promise.withResolvers<void>();
  const read = fixture.store.readStream.bind(fixture.store);
  let reads = 0;
  async function* paused(...args: Parameters<typeof read>) {
    reads++;
    await resume.promise;
    yield* read(...args);
  }
  try {
    const creation = envelope('test', 'conversation-chat', 'conversation.created', {
      conversationId: 'chat', mode: 'agent_session', createdBy: 'alice', assistantId: 'assistant',
    });
    const stop = envelope('test', 'conversation-chat', 'agent.turn_stop_requested', {
      conversationId: 'chat', turnId: 'turn', requestedBy: 'alice',
    });
    await fixture.seed([creation, stop]);
    vi.spyOn(fixture.store, 'readStream').mockImplementation(paused);
    const request = { conversationId: 'chat', head: 2 };
    expect(() => caughtUpConversation(fixture.store, 'test',
      request.conversationId, request.head, 2))
      .toThrow('Conversation history is catching up');
    expect(() => caughtUpConversation(fixture.store, 'test',
      request.conversationId, request.head, 2))
      .toThrow('Conversation history is catching up');
    resume.resolve();
    await readStreamSummary(fixture.store, 'test', 'conversation-chat',
      decisionChatSummary, Infinity, copy);
    expect(reads).toBe(2);
    const captured = { ...request, head: 1 };
    expect(caughtUpConversation(fixture.store, 'test',
      captured.conversationId, captured.head, 2)).toEqual({
      sequence: 1, conversation: [{ sequence: 1, event: creation }],
    });
    expect(reads).toBe(2);
  } finally {
    resume.resolve();
    vi.restoreAllMocks();
    await fixture.close();
  }
}
it('shares one background catch-up and returns only the captured complete prefix',
  catchesUpOnceAndKeepsCapturedPosition);

async function usesSelectedCatchupClock() {
  const clock = manualClock(Math.ceil(performance.now()) + 20_000);
  const fixture = await natsFixture({ clock });
  const sleep = vi.spyOn(clock, 'sleep');
  try {
    const request = { conversationId: 'chat', head: 1 };
    expect(() => caughtUpConversation(fixture.store, 'test',
      request.conversationId, request.head, 1))
      .toThrow('Conversation history is catching up');
    expect(sleep).toHaveBeenCalledWith(10_000, expect.any(AbortSignal));
    await readStreamSummary(fixture.store, 'test', 'conversation-chat',
      decisionChatSummary, Infinity, copy);
  } finally {
    vi.restoreAllMocks();
    await fixture.close();
  }
}
it('bounds background conversation catch-up with the selected event-store clock',
  usesSelectedCatchupClock);
