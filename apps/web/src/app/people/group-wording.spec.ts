import { expect, it } from 'vitest';
import { grantResourceLabel, isDuplicateName, newGroupId, useGrants }
  from './group-wording';
import { recordIdPattern, type GroupRow } from '@opencrane/protocol';

const row = {
  groupId: 'team', name: 'Sales team', membershipSource: 'local', position: 0,
  payingGroupId: 'team', members: [], access: { source: 'group_membership',
    conversationAccess: false, personalMemoryAccess: false, grants: [
      { resourceType: 'model', resourceId: 'gpt', relation: 'use' },
      { resourceType: 'assistant', resourceId: 'helper', relation: 'acts_for' },
    ] },
} as GroupRow;

function makesValidGroupId() {
  for (const name of ['', '👋', 'X'.repeat(200)]) {
    expect(newGroupId(name)).toMatch(recordIdPattern);
  }
}
it('makes a readable, valid id for any group name', makesValidGroupId);

it('checks duplicate names without case or surrounding spaces', () => {
  expect(isDuplicateName(' sales TEAM ', [row])).toBe(true);
});

it('uses clear wording and omits acts-for grants from the Grants list', () => {
  expect(grantResourceLabel(row.access.grants[0]!.resourceType)).toBe('model');
  expect(grantResourceLabel(row.access.grants[1]!.resourceType)).toBe('assistant');
  expect(useGrants(row.access.grants)).toHaveLength(1);
});

it('shows only the resource id in monospace in the grants card', () => {
  expect(grantResourceLabel(row.access.grants[0]!.resourceType)).toBe('model');
});
