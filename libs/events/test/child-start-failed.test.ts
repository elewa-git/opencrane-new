import { expect, it } from 'vitest';
import { parseEventByType } from '../src/index.ts';

const failure = { id: 'failure', commandId: 'failure',
  type: 'conversation.child_start_failed', source: 'opencrane-server', silo: 'test',
  subject: 'conversation-parent', time: '2026-10-19T00:00:00Z',
  principal: { kind: 'system', id: 'opencrane-server' },
  data: { conversationId: 'parent', requestId: 'request', childConversationId: 'child',
    intentEventId: 'intent', attempt: 1, stage: 'create', reason: 'access_refused' } };
function acceptsFailure() {
  expect(parseEventByType(failure).success).toBe(true);
}
it('accepts a saved server refusal', acceptsFailure);
function refusesFields(patch: object) {
  const data = { ...failure.data, ...patch };
  expect(parseEventByType({ ...failure, data }).success).toBe(false);
}
it.each([{ attempt: 0 }, { attempt: 4 }, { attempt: 1.5 }, { stage: 'dispatch' },
  { reason: 'outage' }, { text: 'private canary' }])('refuses failure fields %j', refusesFields);
function refusesWriter(patch: object) {
  expect(parseEventByType({ ...failure, ...patch }).success).toBe(false);
}
it.each([{ source: 'computer' }, { subject: 'conversation-other' },
  { principal: { kind: 'human', id: 'opencrane-server' } },
  { principal: { kind: 'system', id: 'computer' } }, { commandId: 'other' },
  { report: { computerId: 'pc', sequence: 1, digest: 'a'.repeat(64) } }])(
  'refuses failure writer %j', refusesWriter);

function acceptsActivationFailure() {
  const data = { ...failure.data, stage: 'activation' };
  expect(parseEventByType({ ...failure, data }).success).toBe(true);
}
it('accepts a proven activation refusal', acceptsActivationFailure);
