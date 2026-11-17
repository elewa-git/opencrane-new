import { expect, it } from 'vitest';
import { natsFixture } from '@opencrane/event-store/testing';
import { envelope } from '@opencrane/models';
import { createLogger } from '@opencrane/observability';
import { conversations, ProjectionRunner, rebuildConversationsProjection } from '../src/index.ts';
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

async function upgradesOldInstallation() {
  const setup = await setupIndex();
  try {
    const before = await setup.rows();
    await setup.storage.db.query('DROP TABLE decision_conversation_events');
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
it('builds the decision index on an old installation and repeats offline replay',
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
    const stored = [];
    for await (const row of setup.nats.store.readStream('conversation-chat')) stored.push(row);
    await conversations.drop(setup.storage.db);
    await conversations.create(setup.storage.db);
    await conversations.apply(setup.storage.db, stored[0]!.event, stored[0]!.sequence);
    await conversations.applyReplies!(setup.storage.db, stored.slice(1));
    expect(await setup.rows()).toEqual(individual);
  } finally {
    await setup.close();
  }
}
it('indexes reply deltas identically when applied individually and in a replay batch',
  matchesReplyBatching);
