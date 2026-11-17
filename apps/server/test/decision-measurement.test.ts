import { countConversationReads } from './support/conversation-reads.ts';
import { appendFile } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import { approvalFixture, seedLongConversation } from './support/approval-fixture.ts';

async function boundsDecisionReads(messageCount: number) {
  const setup = await approvalFixture();
  try {
    const headers = await seedLongConversation(setup, messageCount);
    const store = setup.nats.store;
    const counts = countConversationReads(store, 'conversation-conversation');
    const started = performance.now();
    const response = await setup.call(undefined, headers);
    const decisionMs = performance.now() - started;
    const output = process.env['DECISION_MEASUREMENTS_FILE'];
    if (output) {
      const measurement = { messageCount, decisionMs, status: response.status, ...counts };
      await appendFile(output, JSON.stringify(measurement) + '\n');
    }
    expect(counts.conversationEvents).toBeLessThanOrEqual(8);
    expect(counts.events).toBeLessThanOrEqual(40);
    expect(response.status, response.text).toBe(403);
    vi.restoreAllMocks();
    const { cards } = await setup.read();
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ state: 'requested', canDecide: true });
  } finally {
    vi.restoreAllMocks();
    await setup.close();
  }
}

it.each([100, 1500, 5000])('bounds decision reads after %i earlier messages',
  boundsDecisionReads, 40_000);

async function readsLongConversationCallStatus() {
  const setup = await approvalFixture();
  try {
    const headers = await seedLongConversation(setup);
    const decision = await setup.call(undefined, headers);
    expect(decision.status, decision.text).toBe(403);
    const { cards } = await setup.read();
    const approvalId = cards[0]!.approvalId;
    const counts = countConversationReads(setup.nats.store, 'conversation-conversation');
    const response = await setup.app.inject({
      url: `/api/conversations/conversation/tool-requests/${approvalId}`,
      headers: setup.headers(),
    });
    expect(counts.conversationEvents).toBeLessThanOrEqual(8);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ approvalId, requesterId: 'alice' });
  } finally {
    vi.restoreAllMocks();
    await setup.close();
  }
}
it('reads original call status after 5,000 messages without replaying the conversation',
  readsLongConversationCallStatus, 40_000);
