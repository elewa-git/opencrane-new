import { expect, it } from 'vitest';
import { manualClock, natsFixture } from '@opencrane/event-store/testing';
import { conversations, ProjectionRunner } from '@opencrane/projections';
import { database } from '@opencrane/projections/testing';
import { createLogger } from '@opencrane/observability';
import { envelope } from '../src/actor.ts';
import { decisionConversationReader } from '../src/decision-conversation.ts';

async function readsWithDifferentClockOrigins() {
  const clock = manualClock(performance.now() - 10_000);
  const nats = await natsFixture({ clock });
  const storage = await database('pg');
  const logger = createLogger('decision-conversation-clock', { level: 'silent' });
  try {
    const runner = new ProjectionRunner(storage.db, nats.reader, logger);
    await runner.initialise(conversations);
    const created = envelope('test', 'conversation-chat', 'conversation.created', {
      conversationId: 'chat', createdBy: 'alice', mode: 'agent_session',
      assistantId: 'assistant',
    });
    await nats.seed([created]);
    await runner.run(conversations);
    const read = decisionConversationReader(nats.store, storage.db, 'test');
    const request = { conversationId: 'chat', turnId: 'turn', head: 1,
      deadline: clock.now() + 2000 };
    expect(await read(request)).toEqual({ sequence: 1,
      conversation: [{ sequence: 1, event: created }] });
  } finally {
    await storage.close();
    await nats.close();
  }
}
it('keeps the database bound when the event-store clock has a different origin',
  readsWithDifferentClockOrigins);
