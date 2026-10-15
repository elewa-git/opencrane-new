import { expect, it } from 'vitest';
import { getEventDefinition, parseEventByType } from '../src/index.ts';

function record() {
  const definition = getEventDefinition('conversation.child_requested');
  expect(definition).toBeDefined();
  return { id: 'intent', commandId: 'intent', type: 'conversation.child_requested',
    source: 'opencrane-server', silo: 'test', subject: 'conversation-parent',
    time: '2026-10-14T00:00:00Z', principal: { kind: 'human', id: 'alice' },
    data: { conversationId: 'parent', sourceMessageId: 'source', sourcePosition: 3,
      requestId: 'request', childConversationId: 'child', firstInputId: 'input',
      createdBy: 'alice', assistantId: 'assistant', payingGroupId: 'team',
      allowanceBoundCents: 1000, initialJoins: [{ participantId: 'alice',
        parentJoinEventId: 'join', parentJoinPosition: 1 }] } };
}
function acceptsRecord() {
  expect(parseEventByType(record()).success).toBe(true);
}
it('accepts the server intent without source text', acceptsRecord);
function refusesData(patch: object) {
  const saved = record();
  saved.data = { ...saved.data, ...patch };
  expect(parseEventByType(saved).success).toBe(false);
}
it.each([{ allowanceBoundCents: 0 }, { allowanceBoundCents: 1001 },
  { allowanceBoundCents: 1.5 }, { initialJoins: [] }, { createdBy: 'bob' },
  { text: 'canary' }, { childConversationId: 'parent' }])('refuses invalid data %j', refusesData);
function refusesEnvelope(patch: object) {
  expect(parseEventByType({ ...record(), ...patch }).success).toBe(false);
}
it.each([{ source: 'computer' }, { subject: 'conversation-other' },
  { principal: { kind: 'human', id: 'bob' } }, { principal: { kind: 'agent', id: 'alice' } },
  { commandId: undefined }, { report: { computerId: 'pc', sequence: 1, digest: 'a'.repeat(64) } }])(
  'refuses a forged writer %j', refusesEnvelope);
function refusesJoins() {
  const saved = record();
  const join = saved.data.initialJoins[0]!;
  for (const initialJoins of [[join, join], [{ ...join, parentJoinPosition: 3 }],
    [{ ...join, parentJoinPosition: 4 }], Array(98).fill(join)]) {
    refusesData({ initialJoins });
  }
}
it('refuses duplicate, oversized and late joins', refusesJoins);
