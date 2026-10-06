import { expect, it } from 'vitest';
import { chatRowSchema, chatMessageSchema } from '../src/index.ts';

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
    { durationMs: -1 }, { durationMs: 1.5 }, { outcome: 'maybe' },
    { requestId: 1 }, { approvalId: false },
  ];
  for (const fields of invalidFields) {
    const invalid = { ...row, data: { ...row.data, ...fields } };
    expect(chatRowSchema.safeParse(invalid).success).toBe(false);
  }
}
it('validates optional tool progress and decision fields in chat rows', validatesToolAndDecisionFields);
