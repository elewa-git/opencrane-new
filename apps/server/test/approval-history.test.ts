import { expect, it, vi } from 'vitest';
import { approvalFixture, prepareLongConversation } from './support/approval-fixture.ts';

async function keepsLongConversationOutsideAccessCheck() {
  const setup = await approvalFixture();
  try {
    await prepareLongConversation(setup);
    const session = setup.headers();
    const { cards, csrf } = await setup.read(session);
    expect(cards[0]).toMatchObject({ state: 'requested', canDecide: true });
    const store = setup.nats.store;
    const originalHead = store.head.bind(store);
    const originalRead = store.readStream.bind(store);
    const originalSubscribe = store.subscribe.bind(store);
    let accessCheckStarted = false;
    const readsFromStart = { readStream: 0, subscribe: 0 };
    function observeHead(...args: Parameters<typeof originalHead>) {
      const [subject, deadline = Infinity] = args;
      if (subject === undefined && deadline - performance.now() <= 2000) {
        accessCheckStarted = true;
      }
      return originalHead(...args);
    }
    function observeRead(...args: Parameters<typeof originalRead>) {
      const [subject, fromSequence = 1] = args;
      if (accessCheckStarted && subject === 'conversation-conversation' && fromSequence === 1) {
        readsFromStart.readStream++;
      }
      return originalRead(...args);
    }
    function observeSubscribe(...args: Parameters<typeof originalSubscribe>) {
      const [fromSequence = 1] = args;
      if (accessCheckStarted && fromSequence === 1) {
        readsFromStart.subscribe++;
      }
      return originalSubscribe(...args);
    }
    vi.spyOn(store, 'head').mockImplementation(observeHead);
    vi.spyOn(store, 'readStream').mockImplementation(observeRead);
    vi.spyOn(store, 'subscribe').mockImplementation(observeSubscribe);
    try {
      const response = await setup.app.inject({ method: 'POST',
        url: '/api/conversations/conversation/approvals',
        headers: { ...session, 'x-csrf-token': csrf },
        payload: { approvalId: cards[0]!.approvalId, decision: 'approved' } });
      expect(response.statusCode, response.body).toBe(200);
      expect(accessCheckStarted).toBe(true);
      expect(readsFromStart).toEqual({ readStream: 0, subscribe: 0 });
    } finally {
      vi.restoreAllMocks();
    }
  } finally {
    await setup.close();
  }
}

it('reads no 5,000-message conversation history from position 1 inside the access check',
  keepsLongConversationOutsideAccessCheck, 40_000);
