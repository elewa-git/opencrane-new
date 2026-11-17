import { expect, it, vi } from 'vitest';
import { conversations } from '@opencrane/projections';
import { envelope, history } from '@opencrane/models';
import { approvalFixture } from './support/approval-fixture.ts';

const terminalFacts = [
  ['agent.turn_stop_requested', { turnId: 'turn', requestedBy: 'alice' }],
  ['agent.turn_completed', { turnId: 'turn' }],
  ['agent.turn_failed', { turnId: 'turn', reason: 'model_error' }],
  ['conversation.closed', { closedBy: 'alice' }],
] as const;

async function refusesMissingFact(type: string, fields: object) {
  const setup = await approvalFixture();
  try {
    expect((await setup.call()).status).toBe(403);
    expect((await setup.decide()).statusCode).toBe(200);
    const subject = type === 'conversation.closed'
      ? 'participation-conversation' : 'conversation-conversation';
    const saved = await setup.append(subject, type, { conversationId: 'conversation', ...fields });
    await setup.append('conversation-conversation', 'agent.output_lost', {
      conversationId: 'conversation', turnId: 'turn' });
    const checkpoint = await setup.runner.checkpoint(conversations);
    await setup.db.query('DELETE FROM decision_conversation_events WHERE event_id=$1', [saved.id]);
    expect(await setup.runner.checkpoint(conversations)).toBe(checkpoint);
    const result = await setup.call();
    expect(result.status, result.text).toBeGreaterThanOrEqual(400);
    expect(setup.received()).toBe(0);
    expect(setup.actor.state.reservations).toHaveLength(0);
    const cards = await history(setup.nats.store, 'approval-*', 'test');
    function consumed(row: typeof cards[number]) {
      return row.event.type === 'approval.used';
    }
    expect(cards.filter(consumed)).toHaveLength(0);
  } finally {
    await setup.close();
  }
}
it.each(terminalFacts)('refuses an approved call when the index omits %s',
  refusesMissingFact, 40_000);

async function boundsUnprojectedTail() {
  const setup = await approvalFixture();
  try {
    const messages = [];
    for (let index = 0; index < 3000; index++) {
      const data = { conversationId: 'conversation', authorId: 'alice', authorKind: 'human',
        contentType: 'text', ciphertext: 'ZmFrZS1jaXBoZXJ0ZXh0', keyId: 'key:1' };
      messages.push(envelope('test', 'conversation-conversation', 'message.posted', data));
    }
    await setup.nats.seed(messages);
    const read = setup.nats.store.readStream.bind(setup.nats.store);
    let decisionRows = 0;
    const accessDeadline = performance.now() + 2000;
    async function* observe(...args: Parameters<typeof read>) {
      for await (const row of read(...args)) {
        if (args[0] === 'conversation-conversation' && (args[2] ?? Infinity) <= accessDeadline) decisionRows++;
        yield row;
      }
    }
    vi.spyOn(setup.nats.store, 'readStream').mockImplementation(observe);
    const result = await setup.call();
    expect(result.status, result.text).toBeGreaterThanOrEqual(400);
    expect(result.text).toContain('Conversation history is catching up');
    expect(decisionRows).toBeLessThanOrEqual(64);
    expect(setup.received()).toBe(0);
    expect(setup.actor.state.reservations).toHaveLength(0);
  } finally {
    vi.restoreAllMocks();
    await setup.close();
  }
}
it('refuses clearly without reading a long unprojected tail inside the decision deadline',
  boundsUnprojectedTail, 40_000);

async function refusesUnprovedCoverage(fault: string) {
  const setup = await approvalFixture();
  try {
    expect((await setup.call()).status).toBe(403);
    expect((await setup.decide()).statusCode).toBe(200);
    if (fault === 'missing') {
      await setup.db.query('DELETE FROM decision_conversation_coverage');
    } else {
      await setup.db.query('UPDATE decision_conversation_coverage SET position=position+1');
    }
    const result = await setup.call();
    expect(result.status, result.text).toBeGreaterThanOrEqual(400);
    expect(setup.received()).toBe(0);
    expect(setup.actor.state.reservations).toHaveLength(0);
  } finally {
    await setup.close();
  }
}
it.each(['missing', 'position'])('refuses %s coverage proof before approval consumption',
  refusesUnprovedCoverage, 40_000);
