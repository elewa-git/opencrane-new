import assert from 'node:assert/strict';
import { it, vi } from 'vitest';
import { natsFixture } from '@opencrane/event-store/testing';
import { envelope } from '@opencrane/models';
import { readChatFacts } from '../src/chat/chat-summary.ts';
import type { Query } from '@opencrane/projections';
import { seedApprovalHistory } from '../../../infra/dev-stack/approval-history.ts';
import { completedApprovalMessage } from '../../../infra/dev-stack/approval-tool.ts';

async function seededHistoryHasNoWaitingTurn() {
  const nats = await natsFixture();
  try {
    const data = { conversationId: 'chat', authorId: 'assistant', authorKind: 'agent',
      contentType: 'text', ciphertext: 'ZmFrZS1jaXBoZXJ0ZXh0', keyId: 'key:1' };
    const message = envelope('test', 'conversation-chat', 'message.posted', data);
    const history = completedApprovalMessage(message);
    await nats.seed(history);
    const facts = await readChatFacts(nats.store, 'test', 'chat', message.id);
    assert.equal(facts.turnEnded, true, 'Earlier fixture messages cannot queue new native work');
    assert.equal(facts.message?.authorId, 'assistant');
  } finally {
    await nats.close();
  }
}
it('seeded long-chat messages are complete before the browser starts a new turn',
  seededHistoryHasNoWaitingTurn);

async function seededHistoryBoundsProjectionBacklog() {
  const nats = await natsFixture();
  let projectedPosition = 0;
  let batches = 0;
  async function observeProjection() {
    const savedPosition = await nats.store.head();
    const pending = savedPosition - projectedPosition;
    assert(pending <= 20,
      `Seed at most 20 event records before observing projection progress; received ${pending}`);
    projectedPosition = savedPosition;
    batches++;
    return { rows: [{ sequence: String(projectedPosition) }] };
  }
  const query = vi.fn();
  query.mockImplementation(observeProjection);
  const db: Query = { query };
  const data = { conversationId: 'chat', authorId: 'assistant', authorKind: 'agent' as const,
    contentType: 'text' as const, ciphertext: 'ZmFrZS1jaXBoZXJ0ZXh0', keyId: 'key:1' };
  try {
    await seedApprovalHistory(nats.store, db, { silo: 'test', data });
    assert.equal(await nats.store.head(), 6_000, 'Keep all 3,000 messages and their completions');
    assert.equal(projectedPosition, 6_000, 'Observe the last seeded completion too');
    assert.equal(batches, 300);
  } finally {
    await nats.close();
  }
}
it('seeding waits for projection progress after at most twenty event records',
  seededHistoryBoundsProjectionBacklog);
