import assert from 'node:assert/strict';
import { it } from 'vitest';
import { natsFixture } from '@opencrane/event-store/testing';
import { envelope } from '@opencrane/models';
import { readChatFacts } from '../src/chat/chat-summary.ts';
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
