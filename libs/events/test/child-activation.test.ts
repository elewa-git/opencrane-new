import { expect, it } from 'vitest';
import { childActivatedEventSchema, parseEventByType } from '../src/index.ts';

const activation = { id: 'activation', commandId: 'activation',
  type: 'conversation.child_activated', source: 'opencrane-server', silo: 'test',
  subject: 'conversation-child', time: '2026-10-23T00:00:00Z',
  principal: { kind: 'human', id: 'alice' },
  data: { conversationId: 'child', parentConversationId: 'parent', requestId: 'request',
    intentEventId: 'intent', intentPosition: 3, creationEventId: 'creation', creationPosition: 4,
    firstInputId: 'input', firstInputPosition: 5, requestedBy: 'alice',
    assistantId: 'assistant', payingGroupId: 'payer', attempt: 1 } };
function acceptsActivation() {
  expect(parseEventByType(activation).success).toBe(true);
  expect(childActivatedEventSchema.safeParse(activation).success).toBe(true);
  const changed = { ...activation, type: 'conversation.child_requested' };
  expect(childActivatedEventSchema.safeParse(changed).success).toBe(false);
}
it('accepts a checked child activation without allowing execution', acceptsActivation);
function refusesFields(patch: object) {
  const data = { ...activation.data, ...patch };
  expect(parseEventByType({ ...activation, data }).success).toBe(false);
}
it.each([{ attempt: 0 }, { attempt: 4 }, { attempt: 1.5 }, { intentEventId: '' },
  { intentPosition: 0 }, { creationPosition: 3 }, { firstInputPosition: 4 },
  { parentConversationId: 'child' }, { requestedBy: 'bob' }, { text: 'private canary' }])(
  'refuses invalid activation fields %j', refusesFields);
function refusesWriter(patch: object) {
  expect(parseEventByType({ ...activation, ...patch }).success).toBe(false);
}
it.each([{ source: 'computer' }, { subject: 'conversation-parent' }, { commandId: 'other' },
  { principal: { kind: 'system', id: 'opencrane-server' } },
  { report: { computerId: 'pc', sequence: 1, digest: 'a'.repeat(64) } }])(
  'refuses an invalid activation writer %j', refusesWriter);
