import { expect, it } from 'vitest';
import { chatMessageSchema, serverMessageSchema } from '../src/index.ts';

const notice = { version: 1, topic: 'conversation', type: 'budget_stop',
  conversationId: 'conversation', turnId: 'turn', position: 12, generation: 1 };
function acceptsNotification() {
  expect(chatMessageSchema.parse(notice)).toEqual(notice);
  expect(serverMessageSchema.parse(notice)).toEqual(notice);
}
it('accepts the typed stop notification in the shared server protocol', acceptsNotification);
const invalid = [
  { ...notice, turnId: undefined }, { ...notice, turnId: '' },
  { ...notice, stopId: 'private' }, { ...notice, limitCents: 10 },
  { ...notice, row: { id: 'row', position: 12, type: 'conversation.closed',
    time: '2026-10-01T00:00:00Z', data: {} } },
  { ...notice, computerState: 'ready' }, { ...notice, computerRecovered: true },
  { ...notice, computerLostAt: '2026-10-01T00:00:00Z' },
  { ...notice, position: -1 }, { ...notice, generation: 0.5 },
];
function rejectsNotification(value: unknown) {
  expect(serverMessageSchema.safeParse(value).success).toBe(false);
}
it.each(invalid)('refuses a malformed or expanded notification: %j', rejectsNotification);
