import { expect, it } from 'vitest';
import { natsFixture } from '@opencrane/event-store/testing';
import { envelope } from '@opencrane/models';
import { createLogger } from '@opencrane/observability';
import {
  conversations, ProjectionRunner, readConversation, rebuildConversationsProjection,
} from '../src/index.ts';
import { database } from './database.ts';

async function activityFixture() {
  const nats = await natsFixture();
  const storage = await database('pg');
  const logger = createLogger('conversation-activity', { level: 'silent' });
  const runner = new ProjectionRunner(storage.db, nats.reader, logger);
  await runner.initialise(conversations);

  async function append(type: string, fields: object) {
    const position = await nats.store.head() + 1;
    const data = { conversationId: 'chat', ...fields };
    const now = new Date(Date.UTC(2026, 9, 10, 12, 0, position));
    const event = envelope('test', 'conversation-chat', type, data, `event-${position}`, now);
    const expectedSequence = await nats.store.head(event.subject);
    const request = { event, expectedSequence };
    expect((await nats.store.append(request)).status).toBe('appended');
    await runner.run(conversations);
    return { event, position };
  }

  async function metadata() {
    const result = await storage.db.query('SELECT * FROM conversations');
    return result.rows[0];
  }

  async function rebuild() {
    await rebuildConversationsProjection(storage.db, nats.reader, logger);
  }

  async function assertRebuildEquality() {
    const before = await metadata();
    const feed = await readConversation(storage.db, 'test', 'chat');
    const participants = await storage.db.query('SELECT * FROM conversation_participants');
    const head = await nats.store.head();
    await rebuild();
    expect(await metadata()).toEqual(before);
    expect((await storage.db.query('SELECT * FROM conversation_participants')).rows)
      .toEqual(participants.rows);
    const rebuilt = await readConversation(storage.db, 'test', 'chat');
    expect(rebuilt.rows).toEqual(feed.rows);
    expect(rebuilt.generation).toBe(feed.generation + 1);
    expect(await runner.checkpoint(conversations)).toBe(head);
    expect(await nats.store.head()).toBe(head);
  }

  async function close() {
    await storage.close();
    await nats.close();
  }

  return { append, metadata, rebuild, assertRebuildEquality, close, storage, runner };
}

const creation = { mode: 'agent_session', createdBy: 'alice', assistantId: 'assistant' };
const postedMessage = {
  authorId: 'alice', authorKind: 'human', ciphertext: 'ZmFrZS1jaXBoZXJ0ZXh0',
  keyId: 'key:1', contentType: 'text',
};
const assistantMessage = {
  turnId: 'turn', messageId: 'reply', ciphertext: 'ZmFrZS1jaXBoZXJ0ZXh0',
  keyId: 'key:1', contentType: 'text',
};
const toolCall = { turnId: 'turn', callId: 'call', serverId: 'tools', toolName: 'read' };
const lateReports = [
  { type: 'agent.message_delta', fields: assistantMessage },
  { type: 'agent.tool_call_started', fields: toolCall },
  { type: 'agent.tool_call_finished', fields: { ...toolCall, status: 'completed' } },
  { type: 'agent.turn_completed', fields: { turnId: 'turn' } },
  { type: 'agent.turn_failed', fields: { turnId: 'turn', reason: 'model_error' } },
  { type: 'agent.message_completed', fields: assistantMessage },
  { type: 'message.posted', fields: postedMessage },
];

async function keepsVisibleActivityAfterClose() {
  const fixture = await activityFixture();
  try {
    const created = await fixture.append('conversation.created', creation);
    expect(await fixture.metadata()).toMatchObject({ latest_activity: String(created.position) });
    await fixture.append('message.posted', postedMessage);
    const firstClose = await fixture.append('conversation.closed', { closedBy: 'alice' });
    for (const report of lateReports) {
      const saved = await fixture.append(report.type, report.fields);
      const participant = await fixture.storage.db.query(
        'SELECT latest_activity FROM conversation_participants WHERE participant_id = $1', ['alice']);
      expect(participant.rows[0]).toEqual({ latest_activity: String(firstClose.position) });
      expect(await fixture.metadata()).toMatchObject({
        latest_activity: String(firstClose.position), closed: true, position: String(saved.position),
      });
    }
    await fixture.assertRebuildEquality();
  } finally {
    await fixture.close();
  }
}
it('keeps the last visible message activity after close and late reports, including after rebuild',
  keepsVisibleActivityAfterClose);

async function keepsFirstCloseEvidence() {
  const fixture = await activityFixture();
  try {
    await fixture.append('conversation.created', creation);
    expect(await fixture.metadata()).toMatchObject({
      closed: false, closed_event_id: null, closed_position: null, closed_by: null, closed_at: null,
    });
    await fixture.append('message.posted', postedMessage);
    const firstClose = await fixture.append('conversation.closed', { closedBy: 'alice' });
    const evidence = {
      closed: true, closed_event_id: firstClose.event.id,
      closed_position: String(firstClose.position), closed_by: 'alice',
      closed_at: firstClose.event.time,
    };
    expect(await fixture.metadata()).toMatchObject({
      ...evidence, latest_activity: String(firstClose.position),
    });
    const secondClose = await fixture.append('conversation.closed', { closedBy: 'bob' });
    expect(await fixture.metadata()).toMatchObject(evidence);
    expect(await fixture.metadata()).toMatchObject({ position: String(secondClose.position) });
    await fixture.assertRebuildEquality();
  } finally {
    await fixture.close();
  }
}
it('keeps the first close event, position, person and time through repeated close and rebuild',
  keepsFirstCloseEvidence);

async function ignoresInternalActivityWhileOpen() {
  const fixture = await activityFixture();
  try {
    await fixture.append('conversation.created', creation);
    const message = await fixture.append('message.posted', postedMessage);
    await fixture.append('agent.message_delta', assistantMessage);
    await fixture.append('agent.tool_call_started', toolCall);
    await fixture.append('agent.turn_completed', { turnId: 'turn' });
    expect(await fixture.metadata()).toMatchObject({ latest_activity: String(message.position) });
    const completed = await fixture.append('agent.message_completed', assistantMessage);
    expect(await fixture.metadata()).toMatchObject({ latest_activity: String(completed.position) });
    await fixture.assertRebuildEquality();
  } finally {
    await fixture.close();
  }
}
it('advances open conversation activity for completed messages but ignores internal reports',
  ignoresInternalActivityWhileOpen);

async function requiresOldTablesToBeRebuilt() {
  const fixture = await activityFixture();
  try {
    await fixture.append('conversation.created', creation);
    await fixture.append('message.posted', postedMessage);
    await fixture.append('conversation.closed', { closedBy: 'alice' });
    const before = await fixture.metadata();
    await fixture.storage.db.query(`ALTER TABLE conversations
      DROP COLUMN closed_event_id, DROP COLUMN closed_position,
      DROP COLUMN closed_by, DROP COLUMN closed_at`);
    await expect(fixture.runner.initialise(conversations)).rejects.toThrow(
      'npm run replay -- conversations --confirm-conversations-stopped');
    expect(await fixture.runner.checkpoint(conversations)).toBe(3);
    await fixture.rebuild();
    expect(await fixture.metadata()).toEqual(before);
  } finally {
    await fixture.close();
  }
}
it('refuses old metadata tables until offline replay restores activity and closing evidence',
  requiresOldTablesToBeRebuilt);

async function rebuildsPreviousParticipantShape() {
  const fixture = await activityFixture();
  try {
    await fixture.append('conversation.created', creation);
    await fixture.append('message.posted', postedMessage);
    await fixture.append('conversation.closed', { closedBy: 'alice' });
    const before = await fixture.metadata();
    const participants = await fixture.storage.db.query('SELECT * FROM conversation_participants');
    const feed = await readConversation(fixture.storage.db, 'test', 'chat');
    await fixture.storage.db.query('ALTER TABLE conversation_participants DROP COLUMN latest_activity');
    await expect(fixture.runner.initialise(conversations)).rejects.toThrow('need rebuilding');
    await fixture.rebuild();
    expect(await fixture.metadata()).toEqual(before);
    expect((await fixture.storage.db.query('SELECT * FROM conversation_participants')).rows)
      .toEqual(participants.rows);
    const rebuilt = await readConversation(fixture.storage.db, 'test', 'chat');
    expect(rebuilt.rows).toEqual(feed.rows);
    expect(rebuilt.generation).toBe(feed.generation + 1);
    expect(await fixture.runner.checkpoint(conversations)).toBe(3);
    expect(await fixture.append('message.posted', postedMessage)).toMatchObject({ position: 4 });
  } finally {
    await fixture.close();
  }
}
it('rebuilds the previous participant table shape before creating its new activity index',
  rebuildsPreviousParticipantShape);
