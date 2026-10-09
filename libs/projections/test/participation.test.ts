import { expect, it } from 'vitest';
import { natsFixture } from '@opencrane/event-store/testing';
import { envelope } from '@opencrane/models';
import { createLogger } from '@opencrane/observability';
import { conversations, ProjectionRunner, readConversation } from '../src/index.ts';
import { database } from './database.ts';

async function replaysParticipation() {
  const nats = await natsFixture();
  const storage = await database('pg');
  try {
    async function append(type: string, subject: string, data: unknown, legacy = false) {
      const event = envelope('test', subject, type, data);
      if (legacy) {
        const saved = await nats.connection.request('ev.conversation.chat', JSON.stringify(event));
        expect(saved.json()).toMatchObject({ seq: 2 });
      } else {
        const expectedSequence = await nats.store.head(subject);
        expect((await nats.store.append({ event, expectedSequence })).status).toBe('appended');
      }
      return event.id;
    }
    const creation = await append('conversation.created', 'conversation-chat', {
      conversationId: 'chat', createdBy: 'alice', mode: 'group', participantIds: ['alice', 'bob'],
      groupId: 'team', groupSnapshotPosition: 1,
    });
    const legacy = await append('participant.added', 'conversation-chat', {
      conversationId: 'chat', participantId: 'carol', addedBy: 'alice',
    }, true);
    const joined = await append('participant.added', 'participation-chat', {
      conversationId: 'chat', participantId: 'dave', addedBy: 'alice',
    });
    const removed = await append('participant.removed', 'participation-chat', {
      conversationId: 'chat', participantId: 'bob', removedBy: 'alice',
    });
    const rejoined = await append('participant.added', 'participation-chat', {
      conversationId: 'chat', participantId: 'bob', addedBy: 'alice',
    });
    const runner = new ProjectionRunner(storage.db, nats.reader, createLogger('participants'));
    await runner.initialise(conversations);
    await runner.run(conversations);
    async function intervals() {
      return (await storage.db.query(`SELECT participant_id, join_position, join_event_id,
        end_position, end_event_id FROM conversation_participants ORDER BY join_position, participant_id`)).rows;
    }
    const before = await intervals();
    expect(before).toEqual([
      { participant_id: 'alice', join_position: '1', join_event_id: creation,
        end_position: null, end_event_id: null },
      { participant_id: 'bob', join_position: '1', join_event_id: creation,
        end_position: '4', end_event_id: removed },
      { participant_id: 'carol', join_position: '2', join_event_id: legacy,
        end_position: null, end_event_id: null },
      { participant_id: 'dave', join_position: '3', join_event_id: joined,
        end_position: null, end_event_id: null },
      { participant_id: 'bob', join_position: '5', join_event_id: rejoined,
        end_position: null, end_event_id: null },
    ]);
    const feed = await readConversation(storage.db, 'test', 'chat');
    expect(feed.rows).toHaveLength(5);
    const metadata = await storage.db.query('SELECT * FROM conversations');
    expect(metadata.rows[0]).toMatchObject({ mode: 'group', created_by: 'alice',
      group_id: 'team', group_snapshot_position: '1', position: '5', closed: false });
    await runner.rebuild(conversations);
    expect(await intervals()).toEqual(before);
    expect((await readConversation(storage.db, 'test', 'chat')).rows).toEqual(feed.rows);
    expect((await storage.db.query('SELECT * FROM conversations')).rows).toEqual(metadata.rows);
    const oldWrite = envelope('test', 'conversation-chat', 'participant.removed', {
      conversationId: 'chat', participantId: 'bob', removedBy: 'alice',
    });
    expect((await nats.store.append({ event: oldWrite, expectedSequence: 2 })).status)
      .toBe('rejected');
    const wrongSubject = { ...oldWrite, subject: 'participation-other' };
    await expect(conversations.apply(storage.db, wrongSubject, 6))
      .rejects.toThrow('Conversation subject mismatch');
    const foreign = { ...oldWrite, silo: 'other' };
    await expect(conversations.apply(storage.db, foreign, 6))
      .rejects.toThrow('Missing conversation in silo');
  } finally {
    await storage.close();
    await nats.close();
  }
}
it('rebuilds initial, legacy and current joins with removal and a fresh re-add interval',
  replaysParticipation);
