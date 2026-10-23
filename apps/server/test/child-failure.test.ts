import { expect, it } from 'vitest';
import type { StoredEvent } from '@opencrane/event-store';
import { childStartState } from '../src/chat/child-failure.ts';

function failure(patch: object = {}): StoredEvent {
  return { sequence: 1, event: { id: 'failure', commandId: 'failure', correlation: {},
    silo: 'test', subject: 'conversation-parent', source: 'opencrane-server',
    type: 'conversation.child_start_failed', time: '2026-10-19T00:00:00Z',
    principal: { kind: 'system', id: 'opencrane-server' },
    data: { conversationId: 'parent', requestId: 'request', childConversationId: 'child',
      intentEventId: 'intent', attempt: 1, stage: 'create', reason: 'access_refused', ...patch } } };
}
function retry(patch: object = {}): StoredEvent {
  const data = { conversationId: 'parent', requestId: 'request', retryId: 'retry',
    failureEventId: 'failure', attempt: 2, ...patch };
  return { sequence: 2, event: { id: 'retry', commandId: 'retry', correlation: {}, silo: 'test',
    subject: `conversation-${data.conversationId}`, source: 'opencrane-server',
    type: 'conversation.child_retry_requested', time: '2026-10-19T00:00:01Z',
    principal: { kind: 'human', id: 'alice' }, data } };
}
function ignoresUnrelatedFailure(patch: object) {
  expect(childStartState([failure(patch)], 'intent')).toEqual({ attempt: 1, failure: undefined });
}
it.each([{ intentEventId: 'other' }, { attempt: 2 }])(
  'ignores a failure outside the current intent and attempt: %j', ignoresUnrelatedFailure);
function ignoresUnrelatedRetry(patch: object) {
  const saved = failure();
  const rows = [saved, retry(patch)];
  expect(childStartState(rows, 'intent')).toEqual({ attempt: 1, failure: saved.event });
}
it.each([{ conversationId: 'other' }, { requestId: 'other' },
  { failureEventId: 'other' }, { attempt: 3 }])(
  'keeps the failure when retry references do not match: %j', ignoresUnrelatedRetry);
function requiresFailure() {
  expect(childStartState([retry()], 'intent')).toEqual({ attempt: 1, failure: undefined });
}
it('does not advance an attempt without a saved failure', requiresFailure);
function advancesMatchingRetry() {
  const rows = [failure(), retry(), failure({ attempt: 1 })];
  expect(childStartState(rows, 'intent')).toEqual({ attempt: 2, failure: undefined });
}
it('advances a matching retry and ignores a late failure from the old attempt', advancesMatchingRetry);
function revalidatesFailure() {
  const rows = [failure({ reason: 'unavailable' })];
  function read() {
    return childStartState(rows, 'intent');
  }
  expect(read).toThrow();
}
it('rejects invalid saved failure data when reading history', revalidatesFailure);
function revalidatesRetry() {
  const row = retry();
  row.event.source = 'computer';
  const rows = [failure(), row];
  function read() {
    return childStartState(rows, 'intent');
  }
  expect(read).toThrow();
}
it('rejects an invalid saved retry writer when reading history', revalidatesRetry);
