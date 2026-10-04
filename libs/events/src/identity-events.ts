// Organisation membership events; the main registry preserves their catalogue order.
import { z } from 'zod';
import { event } from './definition.ts';
import { memberJoinedDataSchema } from './examples.ts';
import * as data from './data.ts';

export const siloOwnerBootstrappedDataSchema = memberJoinedDataSchema.omit({ invitationId: true }).extend({
  memberId: z.literal('bootstrap-owner'), role: z.literal('owner'),
  identity: z.object({ issuer: z.url(), sub: z.string().min(1) }).strict(),
}).strict();

export const identityEvents = [
  event('silo.owner_bootstrapped', 'member', 'The installation token admitted the first owner.',
    siloOwnerBootstrappedDataSchema, { memberId: 'bootstrap-owner', email: 'alice@example.com',
      displayName: 'Alice', role: 'owner', identity: { issuer: 'https://idp.example.com', sub: 'alice' } }),
  // Organisation, members and teams
  event(
    'org.created',
    'org',
    'A new silo (customer organisation) was installed.',
    data.orgCreatedDataSchema,
    { orgName: 'Acme Ltd' },
  ),
  event(
    'member.invited',
    'member',
    'An admin invited someone to join.',
    data.memberInvitedDataSchema,
    { memberId: 'mem_2', email: 'bob@example.com', role: 'member', invitedBy: 'mem_1', invitationId: 'inv_1',
      invitedIdentity: { issuer: 'https://idp.example.com', sub: 'bob' }, expiresAt: '2026-11-01T00:00:00Z' },
  ),
  event(
    'member.joined',
    'member',
    'An invitation was accepted and the person became a member.',
    memberJoinedDataSchema,
    { memberId: 'mem_1', email: 'alice@example.com', displayName: 'Alice', role: 'member' },
  ),
  event(
    'member.role_changed',
    'member',
    "An admin changed a member's role.",
    data.memberRoleChangedDataSchema,
    { memberId: 'mem_1', previousRole: 'member', newRole: 'admin', changedBy: 'mem_2' },
  ),
  event(
    'member.removed',
    'member',
    'An admin removed a member from the silo.',
    data.memberRemovedDataSchema,
    { memberId: 'mem_1', removedBy: 'mem_2' },
  ),
  event('team.created', 'team', 'An admin created a team.', data.teamCreatedDataSchema, {
    teamId: 'team_1',
    name: 'Sales',
    createdBy: 'mem_1',
  }),
  event(
    'team.member_added',
    'team',
    'An admin added a member to a team.',
    data.teamMemberAddedDataSchema,
    { teamId: 'team_1', memberId: 'mem_1', addedBy: 'mem_2' },
  ),
  event(
    'team.member_removed',
    'team',
    'An admin removed a member from a team.',
    data.teamMemberRemovedDataSchema,
    { teamId: 'team_1', memberId: 'mem_1', removedBy: 'mem_2' },
  ),

];
