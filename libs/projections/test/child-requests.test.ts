import { afterAll, beforeAll, expect, it } from 'vitest';
import type { EventEnvelope } from '@opencrane/events';
import { childRequests } from '../src/index.ts';
import { database } from './database.ts';

let storage: Awaited<ReturnType<typeof database>>;
async function setup() {
  storage = await database('pg');
  await childRequests.create(storage.db);
}
async function cleanup() {
  await storage.close();
}
beforeAll(setup);
afterAll(cleanup);

const intent: EventEnvelope = { id: 'intent', commandId: 'intent', correlation: {}, silo: 'test',
  source: 'opencrane-server', subject: 'conversation-parent',
  type: 'conversation.child_requested', time: '2026-10-19T00:00:00Z',
  principal: { kind: 'human', id: 'alice' },
  data: { conversationId: 'parent', requestId: 'request', sourceMessageId: 'source',
    sourcePosition: 2, childConversationId: 'child', firstInputId: 'input',
    createdBy: 'alice', assistantId: 'helper', payingGroupId: 'payer', allowanceBoundCents: 1000,
    initialJoins: [{ participantId: 'alice', parentJoinEventId: 'join', parentJoinPosition: 1 }] } };
const failure: EventEnvelope = { ...intent, id: 'failure', commandId: 'failure', correlation: {},
  type: 'conversation.child_start_failed', principal: { kind: 'system', id: 'opencrane-server' },
  data: { conversationId: 'parent', requestId: 'request', childConversationId: 'child',
    intentEventId: 'intent', attempt: 1, stage: 'create', reason: 'access_refused' } };
function retry(patch: object = {}, silo = 'test'): EventEnvelope {
  const data = { conversationId: 'parent', requestId: 'request', retryId: 'retry',
    failureEventId: 'failure', attempt: 2, ...patch };
  return { ...intent, id: 'retry', commandId: 'retry', correlation: {}, silo,
    type: 'conversation.child_retry_requested', subject: `conversation-${data.conversationId}`, data };
}
async function seedFailure() {
  await childRequests.apply(storage.db, intent, 3);
  await childRequests.apply(storage.db, failure, 4);
}
async function savedFailure(silo = 'test') {
  const result = await storage.db.query(
    'SELECT failed_attempt, failure_id FROM child_requests_v3 WHERE silo = $1 AND intent_id = $2',
    [silo, 'intent']);
  return result.rows;
}
async function keepsUnrelatedFailure(patch: object, silo: string) {
  await seedFailure();
  if (silo === 'other') {
    const otherIntent = { ...intent, silo };
    const otherFailure = { ...failure, silo, id: 'other-failure', commandId: 'other-failure' };
    await childRequests.apply(storage.db, otherIntent, 3);
    await childRequests.apply(storage.db, otherFailure, 4);
  }
  await childRequests.apply(storage.db, retry(patch, silo), 5);
  if (silo === 'other') {
    expect(await savedFailure(silo)).toEqual([{ failed_attempt: 1, failure_id: 'other-failure' }]);
  }
  expect(await savedFailure()).toEqual([{ failed_attempt: 1, failure_id: 'failure' }]);
}
it.each([[{}, 'other'], [{ conversationId: 'other' }, 'test'],
  [{ requestId: 'other' }, 'test'], [{ failureEventId: 'other' }, 'test'],
  [{ attempt: 3 }, 'test']])(
  'keeps failures when a retry differs in %j or silo %s', keepsUnrelatedFailure);
async function clearsMatchingFailure() {
  await seedFailure();
  await childRequests.apply(storage.db, retry(), 5);
  expect(await savedFailure()).toEqual([{ failed_attempt: null, failure_id: null }]);
}
it('clears only the matching failure for the next attempt', clearsMatchingFailure);
async function rejectsInvalidRetry() {
  await seedFailure();
  const event = { ...retry(), source: 'computer' };
  await expect(childRequests.apply(storage.db, event, 5)).rejects.toThrow();
  expect(await savedFailure()).toEqual([{ failed_attempt: 1, failure_id: 'failure' }]);
}
it('revalidates retry records before clearing a failure', rejectsInvalidRetry);
