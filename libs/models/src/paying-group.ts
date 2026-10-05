import type { EventStore, StoredEvent } from '@opencrane/event-store';
import { memberAuthorisation, type Binding } from '@opencrane/authz';
import { history } from './actor.ts';
import { data } from './state.ts';

export class PayingGroupRefused extends Error {}
export class AuthorityApplying extends Error {}
function isMemberState(row: StoredEvent) {
  const memberStateTypes = [
    'silo.owner_bootstrapped', 'member.joined', 'member.role_changed', 'member.removed',
  ];
  return memberStateTypes.includes(row.event.type);
}
function isCreated(row: StoredEvent) {
  return row.event.type === 'team.created';
}
function needsReceipt(row: StoredEvent) {
  return row.event.type !== 'member.invited';
}
async function readMembership(store: EventStore, silo: string, requesterId: string,
  groupId: string, deadline: number) {
  const groupRead = history(store, `team-${groupId}`, silo, deadline);
  const memberRead = history(store, `member-${requesterId}`, silo, deadline);
  const [groupRows, memberRows] = await Promise.all([groupRead, memberRead]);
  return { groupRows, memberRows };
}
function requireMembership(groupRows: StoredEvent[], memberRows: StoredEvent[],
  requesterId: string, groupId: string) {
  const live = memberRows.findLast(isMemberState);
  if (!live || live.event.type === 'member.removed') {
    throw new PayingGroupRefused('Active silo membership required');
  }
  const created = groupRows.find(isCreated);
  function matchesMembership(row: StoredEvent) {
    const membershipEvent = ['team.member_added', 'team.member_removed'].includes(row.event.type);
    return membershipEvent && data(row.event)['memberId'] === requesterId;
  }
  const membership = groupRows.findLast(matchesMembership);
  if (!created || data(created.event)['teamId'] !== groupId ||
      membership?.event.type !== 'team.member_added') {
    throw new PayingGroupRefused('Paying group unavailable or spending permission refused');
  }
}
async function requireApplied(binding: Binding, silo: string, requesterId: string,
  groupId: string, groupRows: StoredEvent[], memberRows: StoredEvent[]) {
  if (binding.silo !== silo) throw new PayingGroupRefused('Wrong silo');
  const auth = memberAuthorisation(binding);
  const memberReceipts = memberRows.filter(needsReceipt);
  function concernsRequester(row: StoredEvent) {
    return row.event.type === 'team.created' || data(row.event)['memberId'] === requesterId;
  }
  const groupReceipts = groupRows.filter(concernsRequester);
  const receiptRows = [...groupReceipts, ...memberReceipts];
  for (const row of receiptRows) {
    if (!await auth.applied(row.event.id)) {
      throw new AuthorityApplying('Group membership is still being applied; try again shortly');
    }
  }
  const memberPermission = await auth.check(requesterId, 'member');
  const groupPermission = await auth.team(requesterId, groupId);
  if (memberPermission.status === 'unavailable' || groupPermission.status === 'unavailable') {
    throw new Error('IAM unavailable');
  }
  if (!memberPermission.allowed || !groupPermission.allowed) {
    throw new PayingGroupRefused('Paying group unavailable or spending permission refused');
  }
}

export async function groupMembership(store: EventStore, silo: string, requesterId: string,
  groupId: string, binding: Binding, deadline = Infinity) {
  const { groupRows, memberRows } = await readMembership(
    store, silo, requesterId, groupId, deadline);
  requireMembership(groupRows, memberRows, requesterId, groupId);
  await requireApplied(binding, silo, requesterId, groupId, groupRows, memberRows);
}

/** Shared spending requires both active silo membership and current group membership. */
export async function payingGroupAuthority(store: EventStore, silo: string,
  requesterId: string, groupId: string, binding?: Binding, callerDeadline = Infinity) {
  const started = performance.now();
  const deadline = Math.min(started + 2000, callerDeadline);
  const { groupRows, memberRows } = await readMembership(
    store, silo, requesterId, groupId, deadline);
  requireMembership(groupRows, memberRows, requesterId, groupId);
  if (binding) {
    await requireApplied(binding, silo, requesterId, groupId, groupRows, memberRows);
  }
  async function fresh() {
    // Compare against the histories we authorised, so a concurrent removal fails closed.
    const groupHead = await store.head(`team-${groupId}`, deadline);
    const memberHead = await store.head(`member-${requesterId}`, deadline);
    const expired = performance.now() >= deadline;
    if (groupHead !== groupRows.at(-1)?.sequence || memberHead !== memberRows.at(-1)?.sequence ||
        expired) {
      throw new PayingGroupRefused('Paying group authority changed; try again');
    }
  }
  return fresh;
}
