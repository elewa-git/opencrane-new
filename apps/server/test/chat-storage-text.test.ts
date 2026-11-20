import { expect, it } from 'vitest';
import { natsFixture } from '@opencrane/event-store/testing';
import { database } from '@opencrane/projections/testing';
import { conversations, ProjectionRunner, readConversation } from '@opencrane/projections';
import { createLogger } from '@opencrane/observability';
import { memorySink } from '@opencrane/observability/testing';
import { chatCommand } from '../src/chat/commands.ts';
import { recordReport } from '../src/chat/reports.ts';

const canary = 'private-chat-storage-canary';
const unsupported = ['\u0000', '\ud800', '\udfff'];

async function refusesUnsupportedText(character: string) {
  const nats = await natsFixture();
  const storage = await database('pg');
  const logs = memorySink();
  const logger = createLogger('storage-text-test', { destination: logs.stream, level: 'info' });
  try {
    const owner = { silo: 'test', memberId: 'alice' };
    const creation = { id: 'created', conversationId: 'chat', assistantId: 'assistant' };
    await chatCommand(nats.store, owner, creation);
    const privateText = `${canary}${character}after`;
    const message = { id: 'unsafe', conversationId: 'chat', text: privateText };
    await expect(chatCommand(nats.store, owner, message)).rejects.toThrow();
    expect(await nats.store.head()).toBe(1);
    await chatCommand(nats.store, owner, { ...message, id: 'safe', text: 'Hello \u0001 \u{1F680}' });
    const context = { silo: 'test', computerId: 'computer', assistantId: 'assistant' };
    const report = { sequence: 1, conversationId: 'chat', turnId: 'safe',
      assistantId: 'assistant', messageId: 'reply', type: 'agent.message_completed',
      text: privateText };
    await expect(recordReport(nats.store, context, report)).rejects.toThrow();
    expect(await nats.store.head()).toBe(2);
    await recordReport(nats.store, context, { ...report, text: 'A safe reply' });
    const runner = new ProjectionRunner(storage.db, nats.store, logger);
    await runner.initialise(conversations);
    await runner.run(conversations);
    expect(await runner.checkpoint(conversations)).toBe(3);
    const before = await readConversation(storage.db, 'test', 'chat');
    expect(before.rows[1]?.data).toMatchObject({ utterance: 'Hello \u0001 \u{1F680}' });
    expect(before.rows.at(-1)?.data).toMatchObject({ utterance: 'A safe reply' });
    await runner.rebuild(conversations);
    expect(await runner.checkpoint(conversations)).toBe(3);
    expect((await readConversation(storage.db, 'test', 'chat')).rows).toEqual(before.rows);
    expect(logs.text()).not.toContain(canary);
  } finally {
    await storage.close();
    await nats.close();
  }
}
it.each(unsupported)('refuses unsupported text before append and keeps replay advancing: %j',
  refusesUnsupportedText);

async function hidesPostgresErrorContext() {
  const nats = await natsFixture();
  const storage = await database('pg');
  const logs = memorySink();
  const logger = createLogger('storage-error-test', { destination: logs.stream, level: 'info' });
  try {
    await chatCommand(nats.store, { silo: 'test', memberId: 'alice' },
      { id: 'created', conversationId: 'chat', assistantId: 'assistant' });
    async function apply(db: typeof storage.db) {
      // Reproduce PostgreSQL's context for an unsupported JSONB escape.
      await db.query('SELECT $1::jsonb', [`{"utterance":"${canary}\\u0000after"}`]);
    }
    const failing = { ...conversations, apply };
    const runner = new ProjectionRunner(storage.db, nats.store, logger);
    await runner.initialise(failing);
    await expect(runner.run(failing)).rejects.toMatchObject({ code: '22P05' });
    const output = logs.text();
    expect(output).toContain('handler.failed');
    expect(output).toContain('22P05');
    expect(output).not.toContain(canary);
  } finally {
    await storage.close();
    await nats.close();
  }
}
it('keeps private PostgreSQL error context out of projection logs', hidesPostgresErrorContext);

async function refusesUnsupportedReport(character: string) {
  const nats = await natsFixture();
  try {
    const owner = { silo: 'test', memberId: 'alice' };
    await chatCommand(nats.store, owner,
      { id: 'created', conversationId: 'chat', assistantId: 'assistant' });
    await chatCommand(nats.store, owner,
      { id: 'message', conversationId: 'chat', text: 'Hello' });
    const context = { silo: 'test', computerId: 'computer', assistantId: 'assistant' };
    const report = { sequence: 1, conversationId: 'chat', turnId: 'message',
      assistantId: 'assistant', messageId: 'reply', type: 'agent.message_completed',
      text: `${canary}${character}after` };
    await expect(recordReport(nats.store, context, report)).rejects.toThrow();
    expect(await nats.store.head()).toBe(2);
  } finally {
    await nats.close();
  }
}
it.each(unsupported)('refuses an unsupported report before append: %j', refusesUnsupportedReport);
