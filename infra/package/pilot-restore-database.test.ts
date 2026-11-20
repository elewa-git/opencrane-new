import { expect, it } from 'vitest';
import { natsFixture } from '@opencrane/event-store/testing';
import { database } from '@opencrane/projections/testing';
import { readConversation } from '@opencrane/projections';
import { envelope } from '@opencrane/models';
import { replayPilotTables, checkPilotCheckpoints } from './pilot-restore-database.ts';

async function replaysReadableContentWithoutEffects() {
  const events = await natsFixture();
  const first = await database('pg');
  const second = await database('pg');
  try {
    const created = envelope('test', 'conversation-chat', 'conversation.created', {
      conversationId: 'chat', assistantId: 'assistant', createdBy: 'alice', mode: 'agent_session',
    });
    const message = envelope('test', 'conversation-chat', 'message.posted', {
      conversationId: 'chat', authorId: 'alice', authorKind: 'human', contentType: 'text',
      utterance: 'A saved conversation',
    });
    await events.store.append({ event: created, expectedSequence: 0 });
    await events.store.append({ event: message, expectedSequence: 1 });
    await replayPilotTables(first.db, events.store, 2);
    await replayPilotTables(second.db, events.store, 2);
    await checkPilotCheckpoints(first.db, 2);
    const before = await readConversation(first.db, 'test', 'chat');
    expect(await readConversation(second.db, 'test', 'chat')).toEqual(before);
    expect(before.rows[1]?.data).toMatchObject({ utterance: 'A saved conversation' });
    expect(await events.store.head()).toBe(2);
    await expect(replayPilotTables(second.db, events.store, 1)).rejects.toThrow('Event position differs');
  } finally {
    await first.close();
    await second.close();
    await events.close();
  }
}
it('replays every installed projection from real events without appending effects',
  replaysReadableContentWithoutEffects);
