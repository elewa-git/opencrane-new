import { expect, it } from 'vitest';
import { natsFixture } from '@opencrane/event-store/testing';
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
    const data = invalidData(type);
    const invalid = envelope('test', 'conversation-direct', type, data);
    expect((await nats.store.append({ expectedSequence: saved.sequence, event: invalid })).status)
      .toBe('appended');
    const runner = new ProjectionRunner(storage.db, nats.reader, createLogger('direct-mode'));
    await runner.initialise(conversations);
    await expect(runner.rebuild(conversations)).rejects.toThrow('Direct conversation is immutable');
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
