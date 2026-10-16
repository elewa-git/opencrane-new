import { expect, it, vi } from 'vitest';
import { event, natsFixture } from '@opencrane/event-store/testing';
import { databases } from '@opencrane/authz/testing';
import { conversations, pgDb, ProjectionRunner, readConversation } from '@opencrane/projections';
import { createLogger } from '@opencrane/observability';
import { replay } from '../src/replay.ts';

async function refusesOnlineReplay() {
  await expect(replay(['conversations'], {})).rejects.toThrow('--confirm-conversations-stopped');
  const args = ['conversations', '--confirm-conversations-stopped', '--verify'];
  await expect(replay(args, {})).rejects.toThrow('does not support --verify');
}
it('requires stopped conversation readers and workers before replay', refusesOnlineReplay);

async function upgradesConversationTables() {
  const storage = await databases();
  const nats = await natsFixture();
  const db = pgDb(storage.queue);
  const runner = new ProjectionRunner(db, nats.reader, createLogger('conversation-upgrade'));
  const output = vi.spyOn(console, 'log');
  try {
    const created = { ...event('created', 'conversation-chat', 'conversation.created'),
      data: { conversationId: 'chat', mode: 'group', createdBy: 'alice',
        participantIds: ['alice', 'bob'] } };
    expect((await nats.store.append({ event: created, expectedSequence: 0 })).status)
      .toBe('appended');
    await runner.initialise(conversations);
    await runner.run(conversations);
    const feed = await readConversation(db, 'test', 'chat');
    const savedRows = await db.query('SELECT * FROM conversation_feed ORDER BY position');
    await db.query('DROP TABLE conversation_participants, conversations');
    await expect(runner.initialise(conversations)).rejects.toThrow(
      'npm run replay -- conversations --confirm-conversations-stopped');
    expect(await runner.checkpoint(conversations)).toBe(1);
    expect(await db.query('SELECT * FROM conversation_feed ORDER BY position')).toEqual(savedRows);
    const env = { ...nats.env('projection'),
      DATABASE_URL: String(storage.queue.options.connectionString) };
    await replay(['conversations', '--dry-run'], env);
    expect(output).toHaveBeenCalledWith(
      'DRY RUN: conversations can replay 1 events; nothing changed.');
    await replay(['conversations', '--confirm-conversations-stopped'], env);
    await runner.initialise(conversations);
    expect(await runner.checkpoint(conversations)).toBe(1);
    expect((await db.query('SELECT participant_id FROM conversation_participants ORDER BY participant_id'))
      .rows).toEqual([{ participant_id: 'alice' }, { participant_id: 'bob' }]);
    expect((await readConversation(db, 'test', 'chat')).rows).toEqual(feed.rows);
    expect((await db.query("SELECT generation FROM projection_generations WHERE name = 'conversations'"))
      .rows).toEqual([{ generation: '1' }]);
    await db.query('TRUNCATE conversation_participants');
    await expect(runner.initialise(conversations)).rejects.toThrow('npm run replay -- conversations');
  } finally {
    output.mockRestore();
    await nats.close();
    await storage.close();
  }
}
it('refuses an upgrade with empty new tables and rebuilds them from the saved history',
  upgradesConversationTables);
