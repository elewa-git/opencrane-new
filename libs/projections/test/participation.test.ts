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

async function comparesOldAndNewParticipation() {
  const storage = await database('pg');
  const nats = await natsFixture();
  try {
    async function save(type: string, data: unknown) {
      const event = envelope('test', 'conversation-chat', type, data);
      const reply = await nats.connection.request('ev.conversation.chat', JSON.stringify(event));
      const acknowledgement: { seq: number } = reply.json();
      return { event, sequence: acknowledgement.seq };
    }
    const created = await save('conversation.created', { conversationId: 'chat',
      mode: 'group', createdBy: 'ext:jane', participantIds: ['ext:jane', 'bob'] });
    const added = await save('participant.added', { conversationId: 'chat',
      participantId: 'carol', addedBy: 'ext:jane' });
    const duplicate = await save('participant.added', added.event.data);
    const absent = await save('participant.removed', { conversationId: 'chat',
      participantId: 'absent', removedBy: 'ext:jane' });
    const removed = await save('participant.removed', { conversationId: 'chat',
      participantId: 'bob', removedBy: 'ext:jane' });
    const closed = await save('conversation.closed', { conversationId: 'chat', closedBy: 'ext:jane' });
    const readded = await save('participant.added', { conversationId: 'chat',
      participantId: 'bob', addedBy: 'ext:jane' });
    const records = [created, added, duplicate, absent, removed, closed, readded];
    const runner = new ProjectionRunner(storage.db, nats.reader, createLogger('legacy-participation'));
    await runner.initialise(conversations);
    await runner.run(conversations);
    async function state() {
      const metadata = await storage.db.query('SELECT * FROM conversations');
      const participants = await storage.db.query(
        'SELECT * FROM conversation_participants ORDER BY participant_id, join_position');
      const feed = await readConversation(storage.db, 'test', 'chat');
      return { metadata: metadata.rows, participants: participants.rows, feed: feed.rows };
    }
    const legacyState = await state();
    expect(legacyState.metadata[0]).toMatchObject({ closed: true, position: '7' });
    expect(legacyState.participants).toHaveLength(4);
    expect(legacyState.participants[0]).toMatchObject({ participant_id: 'bob',
      join_position: '1', end_position: '5', end_event_id: removed.event.id });
    const currentSource = {
      head() { return Promise.resolve(records.length); },
      async *subscribe() {
        for (const stored of records) {
          let subject = stored.event.subject;
          if (stored.event.type.startsWith('participant.')) subject = 'participation-chat';
          yield { ...stored, event: { ...stored.event, subject } };
        }
      },
    };
    const currentRunner = new ProjectionRunner(storage.db, currentSource,
      createLogger('current-participation'));
    await currentRunner.rebuild(conversations);
    expect(await state()).toEqual(legacyState);
    await storage.reopen();
    expect(await state()).toEqual(legacyState);
  } finally {
    await nats.close();
    await storage.close();
  }
}
it('gives old and new removals identical intervals, ignores repeats and preserves closed state',
  comparesOldAndNewParticipation);

async function refusesParticipantOverflow(initialCount: number) {
  const storage = await database('pg');
  const nats = await natsFixture();
  try {
    function participantId(_unused: unknown, index: number) {
      return `person-${index}`;
    }
    const participantIds = Array.from({ length: initialCount - 1 }, participantId);
    participantIds.push('alice');
    const creation = envelope('test', 'conversation-chat', 'conversation.created', {
      conversationId: 'chat', createdBy: 'alice', mode: 'group', participantIds });
    await nats.connection.request('ev.conversation.chat', JSON.stringify(creation));
    const runner = new ProjectionRunner(storage.db, nats.reader, createLogger('overflow'));
    await runner.initialise(conversations);
    await runner.run(conversations);
    const added = envelope('test', 'participation-chat', 'participant.added', {
      conversationId: 'chat', participantId: 'extra', addedBy: 'alice' });
    expect((await nats.store.append({ event: added, expectedSequence: 0 })).status).toBe('appended');
    await expect(runner.run(conversations)).rejects.toThrow('Conversation participant limit');
    expect(await runner.checkpoint(conversations)).toBe(1);
    expect((await readConversation(storage.db, 'test', 'chat')).rows).toHaveLength(1);
    expect((await storage.db.query('SELECT * FROM conversation_participants')).rows).toHaveLength(initialCount);
  } finally {
    await nats.close();
    await storage.close();
  }
}
it.each([97, 100])('rolls back an addition to %i participants and keeps the last good checkpoint',
  refusesParticipantOverflow);
