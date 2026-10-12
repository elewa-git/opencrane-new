import { expect, it } from 'vitest';
import { natsFixture } from '@opencrane/event-store/testing';
import type { StoredEvent } from '@opencrane/event-store';
import { envelope } from '@opencrane/models';
import { createLogger } from '@opencrane/observability';
import { conversations, ProjectionRunner } from '../src/index.ts';
import { database } from './database.ts';

it.each(['conversation.created', 'participant.added', 'agent.turn_started'])(
  'rejects %s when replay would change a direct conversation audience or dispatch mode',
  rejectsDirectMutation,
);

async function rejectsDirectMutation(type: string) {
  const nats = await natsFixture();
  const storage = await database('pg');
  try {
    const created = envelope('test', 'conversation-direct', 'conversation.created', {
      conversationId: 'direct', createdBy: 'alice', mode: 'direct', participantIds: ['alice', 'bob'],
    });
    const saved = await nats.store.append({ expectedSequence: 0, event: created });
    if (saved.status !== 'appended') throw new Error('Creation failed');
    expect(saved.sequence).toBe(1);
    expect(await nats.store.head(created.subject)).toBe(saved.sequence);
    const data = invalidData(type);
    const invalid = envelope('test', 'conversation-direct', type, data);
    if (type === 'conversation.created' || type === 'participant.added') {
      // Save older invalid history so current command checks cannot prevent testing replay.
      const reply = await nats.connection.request(
        'ev.conversation.direct', JSON.stringify(invalid),
      );
      expect(reply.json()).toEqual({ stream: 'EVENTS', seq: saved.sequence + 1 });
    } else {
      const command = { expectedSequence: saved.sequence, event: invalid };
      const appended = await nats.store.append(command);
      expect(appended.status).toBe('appended');
    }
    const history: StoredEvent[] = [];
    for await (const stored of nats.reader.readStream(created.subject)) {
      history.push(stored);
    }
    expect(history).toEqual([
      { sequence: 1, event: created },
      { sequence: 2, event: invalid },
    ]);
    const runner = new ProjectionRunner(storage.db, nats.reader, createLogger('direct-mode'));
    await runner.initialise(conversations);
    await expect(runner.rebuild(conversations)).rejects.toThrow('Direct conversation is immutable');
    expect(await runner.checkpoint(conversations)).toBe(saved.sequence);
    const metadata = await storage.db.query(
      'SELECT mode, position FROM conversations WHERE silo = $1 AND conversation_id = $2',
      ['test', 'direct'],
    );
    expect(metadata.rows).toEqual([{ mode: 'direct', position: '1' }]);
    const participants = await storage.db.query(
      `SELECT participant_id, end_position FROM conversation_participants
        WHERE silo = $1 AND conversation_id = $2 ORDER BY participant_id`,
      ['test', 'direct'],
    );
    expect(participants.rows).toEqual([
      { participant_id: 'alice', end_position: null },
      { participant_id: 'bob', end_position: null },
    ]);
    const feed = await storage.db.query(
      'SELECT event_id FROM conversation_feed WHERE silo = $1 AND conversation_id = $2',
      ['test', 'direct'],
    );
    expect(feed.rows).toEqual([{ event_id: created.id }]);
  } finally {
    await storage.close();
    await nats.close();
  }
}


function invalidData(type: string) {
  if (type === 'conversation.created') {
    return { conversationId: 'direct', createdBy: 'alice', mode: 'agent_session', assistantId: 'assistant' };
  }
  if (type === 'participant.added') {
    return { conversationId: 'direct', participantId: 'carol', addedBy: 'alice' };
  }
  return { conversationId: 'direct', turnId: 'message', assistantId: 'assistant' };
}
