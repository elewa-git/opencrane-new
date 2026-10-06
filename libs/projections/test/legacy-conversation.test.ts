import { expect, it } from 'vitest';
import { event, natsFixture } from '@opencrane/event-store/testing';
import { createLogger } from '@opencrane/observability';
import { computers, conversations, listConversations, members, ProjectionRunner } from '../src/index.ts';
import { database } from './database.ts';

it('rebuilds conversations and members past an old conversation.created without mode', async () => {
  const nats = await natsFixture(), storage = await database('pg');
  try {
    // Publish the original stored bytes: current append validation must not rewrite this fixture.
    const saved = await nats.connection.request('ev.conversation.old', JSON.stringify({
      id: 'old', type: 'conversation.created', subject: 'conversation-old', silo: 'test',
      source: 'test', time: '2026-10-01T00:00:00Z',
      data: { conversationId: 'old', assistantId: 'assistant', createdBy: 'alice' },
    }));
    expect(saved.json()).toMatchObject({ seq: 1 });
    expect((await nats.store.append({ event: event('joined'), expectedSequence: 0 })).status).toBe('appended');
    const runner = new ProjectionRunner(storage.db, nats.reader, createLogger('legacy-replay', { level: 'silent' }));
    for (const projection of [conversations, members]) {
      await runner.initialise(projection);
      expect(await runner.checkpoint(projection)).toBe(0);
    }
    await runner.initialise(computers);
    const results = await Promise.allSettled([runner.rebuild(conversations), runner.rebuild(members)]);
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(await runner.checkpoint(conversations)).toBe(2);
    expect(await runner.checkpoint(members)).toBe(2);
    expect(await listConversations(storage.db, 'test')).toEqual([
      { conversationId: 'old', assistantId: 'assistant', createdBy: 'alice', mode: 'agent_session', createdAt: '2026-10-01T00:00:00Z' },
    ]);
    expect((await storage.db.query('SELECT member_id, status FROM members')).rows).toEqual([{ member_id: 'alice', status: 'joined' }]);
  } finally { await storage.close(); await nats.close(); }
});
