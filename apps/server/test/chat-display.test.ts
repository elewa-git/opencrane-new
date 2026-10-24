import { expect, it } from 'vitest';
import { parseEventByType } from '@opencrane/events';
import { chatFeedSchema, chatMessageSchema } from '@opencrane/protocol';
import { transcript } from '../../web/test/chat-state.ts';
import { chatDisplayData } from '../src/chat/display.ts';

const requestId = '00000000-0000-4000-8000-000000000001';
const turnId = 'fixture-turn';
const conversationId = 'fixture-conversation';
const callFields = {
  conversationId,
  turnId,
  callId: 'exec-fixture-call',
  serverId: 'fixture-server',
  toolName: 'read_fixture_quote',
};

// Preserve the saved response's fields and timings, with made-up identifiers.
const savedDispatch = {
  id: `${requestId}:tool-dispatch`,
  type: 'tool.dispatch_recorded',
  commandId: `${requestId}:tool-dispatch`,
  source: 'models',
  time: '2026-10-24T14:29:34.691Z',
  subject: `decision-${requestId}`,
  silo: 'test',
  principal: { id: 'models', kind: 'system' },
  correlation: {},
  data: {
    ...callFields,
    requestId,
    logicalRequestId: 'a'.repeat(64),
    startedAt: '2026-10-24T14:29:34.489Z',
    durationMs: 185,
    outcome: 'responded',
    evidence: 'adapter_response_received',
    adapter: {
      decisionId: '00000000-0000-4000-8000-000000000002',
      startId: `${requestId}:tool-dispatch-started`,
      connectionId: 'installed-fixture-server',
      generation: 1,
      recordDigest: 'b'.repeat(64),
      reviewRevision: 373,
    },
  },
};

function displayRow(id: string, position: number, type: string, data: unknown) {
  return { id, position, type, time: savedDispatch.time, data: chatDisplayData(type, data) };
}

function dispatchRow(data: unknown = savedDispatch.data) {
  return displayRow(savedDispatch.id, 444, savedDispatch.type, data);
}

function feedWithDispatch(data: unknown = savedDispatch.data) {
  const posted = { conversationId, authorId: 'alice', text: 'Read the fixture quote.' };
  const turnFields = { conversationId, turnId };
  const finished = { ...callFields, status: 'completed', durationMs: 1140 };
  const reply = {
    conversationId, turnId, messageId: 'fixture-reply', contentType: 'text',
    text: 'Quote DEMO-001: 12500 euro cents, morning delivery. Recorded effects: 0.',
  };
  const rows = [
    displayRow(turnId, 431, 'message.posted', posted),
    displayRow('turn-start', 432, 'agent.turn_started', turnFields),
    displayRow('tool-start', 438, 'agent.tool_call_started', callFields),
    dispatchRow(data),
    displayRow('tool-finish', 445, 'agent.tool_call_finished', finished),
    displayRow('reply', 450, 'agent.message_completed', reply),
    displayRow('turn-finish', 452, 'agent.turn_completed', turnFields),
  ];
  return { rows, position: 452, generation: 0, computerState: 'ready' };
}

function displaysSavedAdapterResponse() {
  expect(parseEventByType(savedDispatch).success).toBe(true);
  const row = dispatchRow();
  const { adapter, ...displayFields } = savedDispatch.data;
  expect(row.data).toEqual(displayFields);
  expect(savedDispatch.data.adapter).toEqual(adapter);

  const feed = chatFeedSchema.parse(feedWithDispatch());
  expect(feed.rows).toContainEqual(row);
  const turns = transcript(feed.rows, 'alice');
  expect(turns.at(-1)).toMatchObject({
    state: 'done',
    text: 'Quote DEMO-001: 12500 euro cents, morning delivery. Recorded effects: 0.',
    tools: [{ callId: callFields.callId, label: callFields.toolName, status: 'completed' }],
  });
  const message = {
    version: 1, topic: 'conversation', conversationId, type: 'event',
    position: row.position, generation: 0, row,
  };
  expect(chatMessageSchema.parse(message)).toEqual(message);
}

it('displays a saved adapter response, tool result and completed reply', displaysSavedAdapterResponse);

function refusesUnexpectedDisplayField(extra: Record<string, unknown>) {
  const feed = chatFeedSchema.parse(feedWithDispatch());
  const row = dispatchRow();
  const invalid = { ...row, data: { ...row.data, ...extra } };
  const invalidFeed = { ...feed, rows: [invalid] };
  expect(chatFeedSchema.safeParse(invalidFeed).success).toBe(false);
  const message = {
    version: 1, topic: 'conversation', conversationId, type: 'event',
    position: row.position, generation: 0, row: invalid,
  };
  expect(chatMessageSchema.safeParse(message).success).toBe(false);
}

const unexpectedFields = [
  { adapter: savedDispatch.data.adapter },
  { unexpected: 'private data' },
  { text: 'not a dispatch display field' },
];
it.each(unexpectedFields)('refuses extra dispatch display fields: %j', refusesUnexpectedDisplayField);

function keepsStoredEvidenceRequired() {
  const row = dispatchRow();
  const missingAdapter = { ...savedDispatch, data: row.data };
  expect(parseEventByType(savedDispatch).success).toBe(true);
  expect(parseEventByType(missingAdapter).success).toBe(false);
  const wrongOutcome = {
    ...savedDispatch, data: { ...savedDispatch.data, outcome: 'not_dispatched' },
  };
  expect(parseEventByType(wrongOutcome).success).toBe(false);
}

it('still requires full adapter evidence in the stored event', keepsStoredEvidenceRequired);

function acceptsAdapterOutcome(evidence: string, outcome: string) {
  const data = { ...savedDispatch.data, evidence, outcome, approvalId: 'fixture-approval' };
  const event = { ...savedDispatch, data };
  expect(parseEventByType(event).success).toBe(true);
  const feed = chatFeedSchema.parse(feedWithDispatch(data));
  expect(feed.rows[3]?.data).toMatchObject({ evidence, outcome, approvalId: 'fixture-approval' });
  expect(feed.rows[3]?.data).not.toHaveProperty('adapter');
}

const adapterOutcomes = [
  ['adapter_response_received', 'responded'],
  ['adapter_transport_uncertain', 'outcome_unknown'],
  ['adapter_dispatch_refused', 'not_dispatched'],
];
it.each(adapterOutcomes)('accepts display evidence %s with outcome %s', acceptsAdapterOutcome);

function refusesInvalidDisplayValue(fields: Record<string, unknown>) {
  const feed = chatFeedSchema.parse(feedWithDispatch());
  const row = dispatchRow();
  const invalid = { ...row, data: { ...row.data, ...fields } };
  const invalidFeed = { ...feed, rows: [invalid] };
  expect(chatFeedSchema.safeParse(invalidFeed).success).toBe(false);
}

const invalidValues = [
  { requestId: 'not-a-uuid' },
  { logicalRequestId: 'not-a-digest' },
  { durationMs: -1 },
  { durationMs: 1.5 },
  { startedAt: 'not-a-date' },
  { outcome: 'completed' },
  { evidence: 'unknown' },
  { callId: undefined },
];
it.each(invalidValues)('refuses invalid dispatch display values: %j', refusesInvalidDisplayValue);
