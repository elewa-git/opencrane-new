import { expect, it } from 'vitest';
import { event as memberEvent, natsFixture } from '@opencrane/event-store/testing';
import { envelope } from '@opencrane/models';
import { createLogger } from '@opencrane/observability';
import { conversations, decisionConversationPositions, ProjectionRunner, rebuildConversationsProjection } from '../src/index.ts';
import { database } from './database.ts';

async function setupIndex() {
  const nats = await natsFixture();
  const storage = await database('pg');
  const logger = createLogger('decision-index-replay', { level: 'silent' });
  const runner = new ProjectionRunner(storage.db, nats.reader, logger);
  await runner.initialise(conversations);
  async function append(type: string, fields: object) {
    const data = { conversationId: 'chat', ...fields };
    await nats.seed([envelope('test', 'conversation-chat', type, data)]);
  }
  await append('conversation.created', {
    createdBy: 'alice', mode: 'agent_session', assistantId: 'assistant',
  });
  await runner.run(conversations);
  async function rows() {
    return (await storage.db.query('SELECT * FROM decision_conversation_events ORDER BY position')).rows;
  }
  async function close() {
    await storage.close();
    await nats.close();
  }
  return { nats, storage, logger, runner, append, rows, close };
}

async function upgradesOldInstallation(missing: string) {
  const setup = await setupIndex();
  try {
    const before = await setup.rows();
    const tables = missing === 'both'
      ? 'decision_conversation_events, decision_conversation_coverage'
      : 'decision_conversation_coverage';
    await setup.storage.db.query(`DROP TABLE ${tables}`);
    await expect(setup.runner.initialise(conversations)).rejects.toThrow('need rebuilding');
    await rebuildConversationsProjection(setup.storage.db, setup.nats.reader, setup.logger);
    expect(await setup.rows()).toEqual(before);
    await rebuildConversationsProjection(setup.storage.db, setup.nats.reader, setup.logger);
    expect(await setup.rows()).toEqual(before);
    expect(await setup.runner.checkpoint(conversations)).toBe(await setup.nats.store.head());
  } finally {
    await setup.close();
  }
}
it.each(['both', 'coverage'])(
  'rebuilds an installation missing %s index tables and repeats offline replay',
  upgradesOldInstallation);

async function matchesReplyBatching() {
  const setup = await setupIndex();
  try {
    const data = { turnId: 'turn', messageId: 'reply', contentType: 'text',
      ciphertext: 'ZmFrZS1jaXBoZXJ0ZXh0', keyId: 'key:1' };
    await setup.append('agent.message_delta', data);
    await setup.runner.run(conversations);
    await setup.append('agent.message_delta', data);
    await setup.runner.run(conversations);
    const individual = await setup.rows();
    const proof = await setup.storage.db.query(
      'SELECT event_count, position FROM decision_conversation_coverage');
    expect(proof.rows).toEqual([{ event_count: '3', position: '3' }]);
    const stored = [];
    for await (const row of setup.nats.store.readStream('conversation-chat')) stored.push(row);
    await conversations.drop(setup.storage.db);
    await conversations.create(setup.storage.db);
    await conversations.apply(setup.storage.db, stored[0]!.event, stored[0]!.sequence);
    await conversations.applyReplies!(setup.storage.db, stored.slice(1));
    expect(await setup.rows()).toEqual(individual);
    const replayProof = await setup.storage.db.query(
      'SELECT event_count, position FROM decision_conversation_coverage');
    expect(replayProof.rows).toEqual(proof.rows);
  } finally {
    await setup.close();
  }
}
it('indexes reply deltas identically when applied individually and in a replay batch',
  matchesReplyBatching);

async function refusesMissingCoverageReason() {
  const setup = await setupIndex();
  try {
    await setup.storage.db.query('DELETE FROM decision_conversation_coverage');
    const lookup = { silo: 'test', conversationId: 'chat', turnId: 'turn',
      metadataTypes: ['conversation.created'], latestTypes: [], ignoredTypes: [],
      deadline: performance.now() + 2000, head: await setup.nats.store.head() };
    await expect(decisionConversationPositions(setup.storage.db, lookup))
      .rejects.toThrow('Conversation index is incomplete');
  } finally {
    await setup.close();
  }
}
it('explains missing coverage proof instead of trusting an empty index',
  refusesMissingCoverageReason);

async function accountsForOtherStreamsWithoutSelectingThem() {
  const setup = await setupIndex();
  try {
    const outside = memberEvent('outside', 'member-outsider-long-id');
    await setup.nats.seed([outside]);
    await setup.runner.run(conversations);
    const references = await setup.rows();
    expect(references).toHaveLength(2);
    const coverage = await setup.storage.db.query(
      'SELECT conversation_id, event_count FROM decision_conversation_coverage');
    expect(coverage.rows).toEqual([{ conversation_id: 'chat', event_count: '1' }]);
    const lookup = { silo: 'test', conversationId: 'chat', turnId: 'turn',
      metadataTypes: ['conversation.created'], latestTypes: [], ignoredTypes: [],
      deadline: performance.now() + 2000, head: await setup.nats.store.head() };
    const selected = await decisionConversationPositions(setup.storage.db, lookup);
    expect(selected.rows).toHaveLength(1);
    expect(selected.rows[0]).toHaveProperty('type', 'conversation.created');
  } finally {
    await setup.close();
  }
}
it('proves the full saved range while keeping other streams out of conversation facts',
  accountsForOtherStreamsWithoutSelectingThem);

async function validatesBeforeIndexing(fault: string) {
  const setup = await setupIndex();
  try {
    const added = envelope('test', 'participation-chat', 'participant.added', {
      conversationId: 'chat', participantId: 'bob', addedBy: 'alice',
    });
    let invalid = { ...added, subject: 'participation-other' };
    let reason = 'Conversation subject mismatch';
    if (fault === 'silo') {
      invalid = { ...added, silo: 'other' };
      reason = 'Conversation does not exist';
    }
    await expect(conversations.apply(setup.storage.db, invalid, 1)).rejects.toThrow(reason);
  } finally {
    await setup.close();
  }
}
it.each(['subject', 'silo'])('validates %s before attempting a repeated index position',
  validatesBeforeIndexing);
