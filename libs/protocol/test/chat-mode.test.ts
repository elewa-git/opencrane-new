import { expect, it } from 'vitest';
import { eventRegistry } from '@opencrane/events';
import { chatRowSchema, chatMessageSchema, chatFeedSchema } from '../src/index.ts';

it('validates mode-correct creation in HTTP rows and realtime envelopes', () => {
  const row = {
    id: 'created', position: 1, type: 'conversation.created', time: '2026-10-05T00:00:00Z',
    data: {
      conversationId: 'direct', createdBy: 'alice', mode: 'direct',
      participantIds: ['alice', 'bob'],
    },
  };
  expect(chatRowSchema.safeParse(row).success).toBe(true);
  const withAssistant = { ...row, data: { ...row.data, assistantId: 'assistant' } };
  expect(chatRowSchema.safeParse(withAssistant).success).toBe(false);
  const envelope = {
    version: 1, topic: 'conversation', conversationId: 'direct', type: 'event',
    position: 1, generation: 0, row: withAssistant,
  };
  expect(chatMessageSchema.safeParse(envelope).success).toBe(false);
  const thirdPerson = { ...row, data: { ...row.data, participantIds: ['alice', 'bob', 'carol'] } };
  expect(chatRowSchema.safeParse(thirdPerson).success).toBe(false);
  const missingMode = { ...row, data: { conversationId: 'old', createdBy: 'alice', assistantId: 'assistant' } };
  expect(chatRowSchema.safeParse(missingMode).success).toBe(true);
});

function validatesToolAndDecisionFields() {
  const row = { id: 'tool', position: 1, type: 'agent.tool_call_finished',
    time: '2026-10-06T12:00:00Z', data: {
      turnId: 'turn', callId: 'call_1', serverId: 'fixture', toolName: 'write',
      status: 'completed', durationMs: 75, outcome: 'allow',
      requestId: 'request', approvalId: 'approval',
    } };
  expect(chatRowSchema.safeParse(row).success).toBe(true);
  const invalidFields = [
    { callId: 1 }, { serverId: [] }, { toolName: null }, { status: 'inProgress' },
    { durationMs: -1 }, { durationMs: 1.5 },
    { requestId: 1 }, { approvalId: false },
  ];
  for (const fields of invalidFields) {
    const invalid = { ...row, data: { ...row.data, ...fields } };
    expect(chatRowSchema.safeParse(invalid).success).toBe(false);
  }
}
it('validates optional tool progress and decision fields in chat rows', validatesToolAndDecisionFields);

function acceptsExistingConversationRows(outcome: string) {
  const rows: unknown[] = [];
  for (const definition of Object.values(eventRegistry)) {
    if (definition.stream !== 'conversation') continue;
    if (definition.type.startsWith('agent.tool_call_')) continue;
    const row = { id: definition.type, position: rows.length + 1, type: definition.type,
      time: '2026-10-06T12:00:00Z', data: definition.example };
    rows.push(row);
  }
  const delivered = { id: 'delivered', position: rows.length + 1, type: 'file.delivered',
    time: '2026-10-06T12:00:00Z', data: { fileId: 'file', outcome } };
  rows.push(delivered);
  const feed = { rows, position: rows.length, generation: 1, computerState: 'ready' };
  expect(chatFeedSchema.safeParse(feed).success).toBe(true);
  const message = { version: 1, topic: 'conversation', conversationId: 'chat', type: 'event',
    position: delivered.position, generation: 1, row: delivered };
  expect(chatMessageSchema.safeParse(message).success).toBe(true);
}
it.each(['saved', 'kept_existing'])(
  'loads existing conversation rows and an upload with outcome %s', acceptsExistingConversationRows);

function validatesDecisionOutcome() {
  const row = { id: 'decision', position: 1, type: 'decision.recorded',
    time: '2026-10-06T12:00:00Z', data: { turnId: 'turn', outcome: 'maybe' } };
  expect(chatRowSchema.safeParse(row).success).toBe(false);
  for (const outcome of ['allow', 'ask', 'deny']) {
    const decision = { ...row, data: { ...row.data, outcome } };
    expect(chatRowSchema.safeParse(decision).success).toBe(true);
  }
}
it('checks decision outcomes only on decision rows', validatesDecisionOutcome);

function acceptsRefusedDispatchOutcome() {
  const row = { id: 'refused', position: 3, type: 'tool.dispatch_recorded',
    time: '2026-10-18T00:00:00Z', data: {
      conversationId: 'conversation', turnId: 'turn', callId: 'call',
      serverId: 'fixture', toolName: 'write',
      requestId: '00000000-0000-4000-8000-000000000001',
      logicalRequestId: 'a'.repeat(64), startedAt: '2026-10-18T00:00:00Z',
      durationMs: 0, outcome: 'not_dispatched', evidence: 'dispatch_refused',
    } };
  expect(chatRowSchema.safeParse(row).success).toBe(true);
  const message = { version: 1, topic: 'conversation', conversationId: 'conversation',
    type: 'event', position: 3, generation: 1, row };
  expect(chatMessageSchema.safeParse(message).success).toBe(true);
}
it('accepts a refused not-sent tool outcome in chat', acceptsRefusedDispatchOutcome);
