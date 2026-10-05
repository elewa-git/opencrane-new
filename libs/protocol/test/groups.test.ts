import { expect, it } from 'vitest';
import { createGroupCommandSchema, groupRowSchema, removeMemberCommandSchema } from '../src/groups.ts';

const sample = {
  groupId: 'sales-team', name: 'Sales team', membershipSource: 'local', position: 0,
  payingGroupId: 'sales-team',
  members: [{ memberId: 'alex-kim', displayName: 'Alex Kim', membershipSource: 'local' }],
  access: { source: 'group_membership', conversationAccess: false,
    personalMemoryAccess: false, grants: [] },
};

it('accepts a group row and ignores fields the screen does not use', () => {
  expect(groupRowSchema.parse({ ...sample, futureField: true })).toMatchObject(sample);
});

it('rejects private conversation access and unknown membership sources', () => {
  expect(groupRowSchema.safeParse({ ...sample, access: { ...sample.access,
    conversationAccess: true } }).success).toBe(false);
  expect(groupRowSchema.safeParse({ ...sample, membershipSource: 'other' }).success).toBe(false);
});

it('rejects unknown create command fields', () => {
  expect(createGroupCommandSchema.safeParse({ commandId: 'cmd', groupId: 'group',
    name: 'Group', expectedSequence: 1 }).success).toBe(false);
});

it('rejects a group id on the strict remove command', () => {
  expect(removeMemberCommandSchema.safeParse({ action: 'remove', commandId: 'cmd',
    memberId: 'alex', groupId: 'sales' }).success).toBe(false);
});
