import { expect, it } from 'vitest';
import { event, natsFixture } from '@opencrane/event-store/testing';
import { createLogger } from '@opencrane/observability';
import { computers, conversations, pgDb, ProjectionRunner, readConversation, listConversations }
  from '@opencrane/projections';
import { createStore, memberAuthorisation, rebuildMembers } from '@opencrane/authz';
import { databases, openfga } from '@opencrane/authz/testing';
import { participation } from '../src/chat/participation.ts';

async function replaysChildParticipation() {
  const nats = await natsFixture();
  const storage = await databases();
  const fga = await openfga();
  const db = pgDb(storage.queue);
  const binding = await createStore(fga.apiUrl, 'test');
  const authorisation = memberAuthorisation(binding, nats.store);
  async function save(id: string, subject: string, type: string, data: unknown) {
    const saved = { ...event(id, subject, type), data };
    const expectedSequence = await nats.store.head(subject);
    const command = { event: saved, expectedSequence };
    expect((await nats.store.append(command)).status).toBe('appended');
    return saved;
  }
  try {
    const aliceData = { memberId: 'alice', email: 'alice@example.test',
      displayName: 'Alice', role: 'member' };
    const bobData = { memberId: 'bob', email: 'bob@example.test',
      displayName: 'Bob', role: 'member' };
    const alice = await save('alice', 'member-alice', 'member.joined', aliceData);
    const bob = await save('bob', 'member-bob', 'member.joined', bobData);
    const creationData = {
      conversationId: 'child', mode: 'agent_session', contextKind: 'shared_child',
      createdBy: 'alice', assistantId: 'assistant', payingGroupId: 'team',
      origin: { parentConversationId: 'parent', sourceMessageId: 'source', sourcePosition: 2,
        intentEventId: 'intent', intentPosition: 3, requestId: 'request', firstInputId: 'input' },
      initialJoins: [
        { participantId: 'alice', parentJoinEventId: 'parent-created', parentJoinPosition: 1 },
        { participantId: 'bob', parentJoinEventId: 'parent-created', parentJoinPosition: 1 },
      ],
    };
    const created = await save('created', 'conversation-child', 'conversation.created', creationData);
    const reader = await participation(nats.store, 'test', 'child', 'bob');
    expect(reader.participantIds).toEqual(['alice', 'bob']);
    expect(reader.joinEventId).toBe('created');
    const runner = new ProjectionRunner(db, nats.reader, createLogger('child-replay'));
    await runner.initialise(computers);
    await runner.initialise(conversations);
    await runner.run(conversations);
    expect(await listConversations(db, 'test', 'bob')).toHaveLength(1);
    const removalData = {
      conversationId: 'child', participantId: 'bob', removedBy: 'alice',
      contextKind: 'shared_child', reviewPosition: 3,
    };
    const removed = await save('removed', 'participation-child', 'participant.removed', removalData);
    await runner.run(conversations);
    const before = await readConversation(db, 'test', 'child');
    expect(await listConversations(db, 'test', 'bob')).toEqual([]);
    await authorisation.handler.handle(alice, db);
    await authorisation.handler.handle(bob, db);
    await authorisation.handler.handle(removed, db);
    await authorisation.handler.handle(created, db);
    expect((await authorisation.conversation('bob', 'child', 'read')).allowed).toBe(false);
    expect((await authorisation.conversation('alice', 'child', 'manage_participants')).allowed)
      .toBe(true);
    const additionData = {
      conversationId: 'child', participantId: 'bob', addedBy: 'alice',
      contextKind: 'shared_child', joinKind: 'explicit_child', reviewPosition: 4,
    };
    const added = await save('rejoined', 'participation-child', 'participant.added', additionData);
    await runner.run(conversations);
    await authorisation.handler.handle(added, db);
    const rejoined = await participation(nats.store, 'test', 'child', 'bob');
    expect(rejoined.joinEventId).toBe('rejoined');
    expect(rejoined.historyPosition).toBe(3);
    expect((await authorisation.conversation('bob', 'child', 'read')).allowed).toBe(true);
    expect((await authorisation.conversation('bob', 'parent', 'read')).allowed).toBe(false);
    const participants = await listConversations(db, 'test', 'bob');
    expect(participants).toHaveLength(1);
    const intervals = await db.query(
      'SELECT * FROM conversation_participants ORDER BY participant_id, join_position');
    expect(intervals.rows).toHaveLength(3);
    expect(intervals.rows[1]).toMatchObject({ participant_id: 'bob', join_event_id: 'created',
      end_event_id: 'removed' });
    const after = await readConversation(db, 'test', 'child');
    expect(after.rows.slice(0, 2)).toEqual(before.rows);
    await runner.rebuild(conversations);
    expect((await readConversation(db, 'test', 'child')).rows).toEqual(after.rows);
    expect(await listConversations(db, 'test', 'bob')).toEqual(participants);
    expect((await db.query(
      'SELECT * FROM conversation_participants ORDER BY participant_id, join_position')).rows)
      .toEqual(intervals.rows);
    const rebuildOptions = { verifyAgainst: binding };
    const rebuilt = await rebuildMembers(fga.apiUrl, 'test', nats.reader, rebuildOptions);
    expect(rebuilt.verified).toBe(true);
  } finally {
    await fga.close();
    await storage.close();
    await nats.close();
  }
}
it('replays child joins and removals and keeps delayed creation from restoring a removed person',
  replaysChildParticipation, 45_000);
