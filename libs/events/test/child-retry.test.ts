import { expect, it } from 'vitest';
import { childRetryRequestedEventSchema, parseEventByType } from '../src/index.ts';

const retry = { id: 'retry', commandId: 'retry',
  type: 'conversation.child_retry_requested', source: 'opencrane-server', silo: 'test',
  subject: 'conversation-parent', time: '2026-10-19T00:00:00Z',
  principal: { kind: 'human', id: 'alice' },
  data: { conversationId: 'parent', requestId: 'request', retryId: 'retry',
    failureEventId: 'failure', attempt: 2 } };
function acceptsRetry() {
  expect(parseEventByType(retry).success).toBe(true);
}
it('accepts a saved requester retry', acceptsRetry);
function refusesFields(patch: object) {
  const data = { ...retry.data, ...patch };
  expect(parseEventByType({ ...retry, data }).success).toBe(false);
}
it.each([{ attempt: 1 }, { attempt: 4 }, { attempt: 1.5 }, { retryId: '' },
  { text: 'private canary' }])('refuses retry fields %j', refusesFields);
function refusesWriter(patch: object) {
  expect(parseEventByType({ ...retry, ...patch }).success).toBe(false);
}
it.each([{ source: 'computer' }, { subject: 'conversation-other' },
  { principal: { kind: 'system', id: 'opencrane-server' } },
  { principal: { kind: 'system', id: 'computer' } }, { commandId: 'other' },
  { report: { computerId: 'pc', sequence: 1, digest: 'a'.repeat(64) } }])(
  'refuses retry writer %j', refusesWriter);

function rejectsDifferentEventType() {
  const changed = { ...retry, type: 'conversation.child_requested' };
  expect(childRetryRequestedEventSchema.safeParse(changed).success).toBe(false);
}
it('rejects a different type through the direct retry schema', rejectsDifferentEventType);
