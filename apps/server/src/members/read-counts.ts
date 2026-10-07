import { memberInvitedDataSchema, memberJoinedDataSchema, legacyMemberRole } from '@opencrane/events';
import { isEventStoreUnavailable } from '@opencrane/event-store';
import type { GroupOptions } from './group-routes.ts';

function count(value: number | null, status: 'current' | 'applying' | 'unavailable' = 'current') {
  return { value, status };
}

export async function memberCounts(options: GroupOptions, checkedAt: string) {
  const deadline = performance.now() + 5000;
  const head = await options.store.head(undefined, deadline);
  const checkpoints = await options.db.query<{ name: string; sequence: string }>(
    "SELECT name, sequence FROM projection_checkpoints WHERE name IN ('members', 'groups')");
  const positions = new Map<string, number>();
  for (const row of checkpoints.rows) {
    positions.set(row.name, Number(row.sequence));
  }
  const membersCurrent = (positions.get('members') ?? -1) >= head;
  const groupsCurrent = (positions.get('groups') ?? -1) >= head;
  let content: 'current' | 'applying' = 'current';
  if (!membersCurrent || !groupsCurrent) content = 'applying';
  const counts = { members: count(null, 'applying'), groups: count(null, 'applying'),
    pendingInvitations: count(null, 'applying'), acceptedInvitations: count(null, 'applying') };
  if (groupsCurrent) {
    const groups = await options.db.query<{ total: string }>(
      'SELECT count(*) AS total FROM groups WHERE silo = $1', [options.silo]);
    counts.groups = count(Number(groups.rows[0]?.total));
  }
  if (!membersCurrent) return { counts, projection: { content } };
  let totals;
  try {
    totals = await invitationTotals(options, checkedAt, head, deadline);
  } catch (error) {
    if (!isEventStoreUnavailable(error)) throw error;
    totals = { members: count(null, 'unavailable'), pendingInvitations: count(null, 'unavailable'),
      acceptedInvitations: count(null, 'unavailable') };
  }
  return { counts: { ...counts, ...totals }, projection: { content } };
}

async function invitationTotals(options: GroupOptions, checkedAt: string,
  head: number, deadline: number) {
  const counts = { members: count(null, 'unavailable'),
    pendingInvitations: count(null, 'unavailable'), acceptedInvitations: count(null, 'unavailable') };
  const roles = new Map<string, string>();
  const invitations = new Map<string, ReturnType<typeof memberInvitedDataSchema.parse>>();
  const accepted = new Set<string>();
  let read = 0;
  // Stop rather than report a partial total. Invitation history will have its own read table.
  for await (const row of options.store.readStream('member-*', 1, deadline)) {
    if (row.sequence > head) break;
    if (row.event.silo !== options.silo) throw new Error('Wrong silo');
    if (++read > 500) {
      return counts;
    }
    const event = row.event;
    const role = legacyMemberRole(event);
    if (role !== undefined) roles.set(event.subject, role);
    if (event.type === 'member.invited') {
      invitations.set(event.subject, memberInvitedDataSchema.parse(event.data));
    } else if (event.type === 'member.joined') {
      const join = memberJoinedDataSchema.parse(event.data);
      if (join.invitationId) accepted.add(`${event.subject}/${join.invitationId}`);
    }
  }
  let members = 0;
  for (const role of roles.values()) {
    if (role) members++;
  }
  const pending = pendingCount(invitations, roles, accepted, checkedAt);
  counts.members = count(members);
  counts.pendingInvitations = count(pending);
  counts.acceptedInvitations = count(accepted.size);
  return counts;
}

function pendingCount(
  invitations: Map<string, ReturnType<typeof memberInvitedDataSchema.parse>>,
  roles: Map<string, string>, accepted: Set<string>, checkedAt: string,
) {
  let pending = 0;
  for (const [subject, invitation] of invitations) {
    if (!roles.get(subject) && !accepted.has(`${subject}/${invitation.invitationId}`)
      && invitation.expiresAt && Date.parse(invitation.expiresAt) > Date.parse(checkedAt)) {
      pending++;
    }
  }
  return pending;
}
