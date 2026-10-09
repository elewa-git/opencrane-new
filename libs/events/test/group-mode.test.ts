import { expect, it } from 'vitest';
import { conversationCreatedDataSchema } from '../src/index.ts';

const group = { conversationId: 'chat', createdBy: 'alice', mode: 'group',
  participantIds: ['alice', 'bob'] };

function acceptsGroup() {
  expect(conversationCreatedDataSchema.parse(group)).toEqual(group);
  const associated = { ...group, groupId: 'team', groupSnapshotPosition: 12 };
  expect(conversationCreatedDataSchema.parse(associated)).toEqual(associated);
}
it('accepts an explicit group audience and a paired group snapshot', acceptsGroup);

const invalidGroups = [
  { ...group, assistantId: 'assistant' }, { ...group, payingGroupId: 'team' },
  { ...group, participantIds: ['alice', 'alice'] },
  { ...group, participantIds: ['bob', 'carol'] }, { ...group, participantIds: ['alice'] },
  { ...group, groupId: 'team' }, { ...group, groupSnapshotPosition: 12 },
  { ...group, groupId: 'team', groupSnapshotPosition: -1 },
  { ...group, groupId: 'team', groupSnapshotPosition: 1.5 },
  { ...group, conversationId: 'provider-reserved' },
  { ...group, participantIds: ['alice', 'bad.id'] },
  { ...group, createdBy: 'a'.repeat(201) },
];
function rejectsGroup(data: unknown) {
  expect(conversationCreatedDataSchema.safeParse(data).success).toBe(false);
}
it.each(invalidGroups)('refuses invalid or mixed group data %#', rejectsGroup);

function participantId(index: number) { return `member_${index}`; }
function boundsAudience() {
  const audience = Array.from({ length: 99 }, (_, index) => participantId(index));
  audience.push('alice');
  expect(conversationCreatedDataSchema.safeParse({ ...group, participantIds: audience }).success)
    .toBe(true);
  audience.push('one_more');
  rejectsGroup({ ...group, participantIds: audience });
  rejectsGroup({ ...group, mode: 'agent_session', assistantId: 'assistant' });
}
it('limits the audience to 100 and keeps session data separate', boundsAudience);
