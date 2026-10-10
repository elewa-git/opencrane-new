import { expect, it } from 'vitest';
import { conversationCreatedDataSchema, parseEventByType } from '../src/index.ts';

const origin = { parentConversationId: 'parent', sourceMessageId: 'source', sourcePosition: 3,
  intentEventId: 'intent', intentPosition: 4, requestId: 'request', firstInputId: 'input' };
const initialJoins = [
  { participantId: 'alice', parentJoinEventId: 'parent-created', parentJoinPosition: 1 },
  { participantId: 'bob', parentJoinEventId: 'bob-joined', parentJoinPosition: 2 },
];
const child = { conversationId: 'child', mode: 'agent_session', contextKind: 'shared_child',
  assistantId: 'assistant', payingGroupId: 'team', createdBy: 'alice', origin, initialJoins };

function parsesDistinctSessions() {
  const legacy = { conversationId: 'private', assistantId: 'assistant', createdBy: 'alice' };
  expect(conversationCreatedDataSchema.parse(legacy)).toEqual({ ...legacy, mode: 'agent_session' });
  expect(conversationCreatedDataSchema.parse(child)).toEqual(child);
}
it('keeps legacy private parsing and accepts recorded shared-child origins and parent joins',
  parsesDistinctSessions);

const invalidChildren = [
  { ...child, contextKind: 'private text' },
  { ...child, origin: { ...origin, sourceMessageId: 'private text' } },
  { ...child, mode: 'group' }, { ...child, participantIds: ['alice', 'bob'] },
  { ...child, payingGroupId: undefined }, { ...child, origin: { ...origin, sourcePosition: -1 } },
  { ...child, origin: { ...origin, parentConversationId: 'child' } },
  { ...child, origin: { ...origin, intentPosition: 3 } },
  { ...child, origin: { ...origin, firstInputId: '' } },
  { ...child, initialJoins: [initialJoins[1]] },
  { ...child, initialJoins: [initialJoins[0], initialJoins[0]] },
  { ...child, initialJoins: [{ ...initialJoins[0], parentJoinPosition: 5 }] },
];
function refusesChild(data: unknown) {
  expect(conversationCreatedDataSchema.safeParse(data).success).toBe(false);
}
it.each(invalidChildren)('refuses malformed origins and mixed child modes %#', refusesChild);

function parsesExplicitJoin() {
  const saved = { id: 'invite', subject: 'participation-child', type: 'participant.added',
    source: 'server', silo: 'test', time: '2026-10-10T12:00:00Z' };
  const data = { conversationId: 'child', participantId: 'carol', addedBy: 'alice',
    contextKind: 'shared_child', joinKind: 'explicit_child', reviewPosition: 8 };
  const joined = { ...saved, data };
  expect(parseEventByType(joined).success).toBe(true);
  const mixed = { ...data, parentJoinEventId: 'parent-created' };
  const invalid = { ...saved, data: mixed };
  expect(parseEventByType(invalid).success).toBe(false);
}
it('records an explicit child-only join without inherited parent rights', parsesExplicitJoin);
