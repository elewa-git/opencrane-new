// Organisation membership events; the main registry preserves their catalogue order.
import { z } from 'zod';
import type { EventEnvelope } from './envelope.ts';
import { event } from './definition.ts';
import { memberJoinedDataSchema } from './examples.ts';
import * as data from './data.ts';

export const siloOwnerBootstrappedDataSchema = memberJoinedDataSchema.omit({
  invitationId: true, personalAssistant: true,
}).extend({
  memberId: z.literal('bootstrap-owner'), role: z.literal('owner'),
  identity: z.object({ issuer: z.url(), sub: z.string().min(1) }).strict(),
}).strict();

const safeReference = z.string().regex(/^[\w-]{1,200}$/u);
export const memberCommandRefusedSchema = z.object({
  memberId: safeReference,
  originalCommandDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  invitationId: safeReference.optional(),
  operation: z.enum(['invite', 'join']),
  inputDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  reason: z.enum(['access_refused', 'identity_mismatch', 'already_member', 'access_removed',
    'concurrent_change', 'wrong_identity', 'unknown_invitation', 'expired_invitation',
    'unbound_invitation', 'invitation_not_pending', 'inviter_authority_ended',
    'ownership_stream_required', 'sign_in_again', 'unsupported_email']),
}).strict();

export const departureCleanupCompletedSchema = z.object({
  memberId: safeReference,
  removalId: safeReference,
  sections: z.object({
    groups: z.array(safeReference).max(100),
    grants: z.array(safeReference).max(100),
    assistant: z.array(safeReference).max(100),
    computer: z.array(safeReference).max(100),
  }).strict(),
}).strict();

export const identityEvents = [
  event('member.departure_cleanup_completed', 'memberaudit',
    'A reviewed departure finished its supported cleanup.', departureCleanupCompletedSchema,
    { memberId: 'mem_2', removalId: 'removal_1',
      sections: { groups: ['removed_1'], grants: ['revoked_1'],
        assistant: ['inactive_1'], computer: ['suspended_1'] } }),
  event('member.command_refused', 'memberaudit', 'A trusted invitation request was refused.',
    memberCommandRefusedSchema, { memberId: 'mem_2', originalCommandDigest: 'b'.repeat(64),
      operation: 'invite', inputDigest: 'a'.repeat(64), reason: 'access_refused' }),
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

/** Invitations grant no role. Only accepted membership events supply legacy role state. */
export function legacyMemberRole(event: EventEnvelope): string | undefined {
  if (event.type === 'member.ownership_confirmed') return 'owner';
  if (event.type === 'member.removed') {
    return '';
  }
  let field: string;
  if (event.type === 'member.joined' || event.type === 'silo.owner_bootstrapped') {
    field = 'role';
  } else if (event.type === 'member.role_changed') {
    field = 'newRole';
  } else {
    return undefined;
  }
  const fields = z.record(z.string(), z.unknown()).parse(event.data);
  return z.string().parse(fields[field]);
}
