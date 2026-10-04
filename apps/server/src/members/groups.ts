import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
import { memberAuthorisation, type Binding } from '@opencrane/authz';
import { authorityFence, history } from '@opencrane/models';

const id = z.string().regex(/^[\w-]{1,200}$/u);
function hasNoNul(value: string) {
  return !value.includes('\0');
}
const groupName = z.string().trim().min(1).max(200).refine(hasNoNul);
const groupInput = z.discriminatedUnion('action', [
  z.object({ action: z.literal('create'), commandId: id, groupId: id, name: groupName }).strict(),
  z.object({ action: z.enum(['add', 'remove']), commandId: id, groupId: id, memberId: id }).strict(),
]);
type GroupInput = z.infer<typeof groupInput>;
export class GroupRefused extends Error {}
export class GroupConflict extends Error {}

function isMemberState(row: StoredEvent) {
  return ['member.joined', 'member.role_changed', 'member.removed'].includes(row.event.type);
}
function needsReceipt(row: StoredEvent) {
  return row.event.type !== 'member.invited';
}

/** Pending role changes and removals deny access until their IAM receipts exist. */
export async function activeMember(
  store: EventStore, binding: Binding, memberId: string, admin = false,
) {
  const rows = await history(store, `member-${memberId}`, binding.silo);
  const state = rows.findLast(isMemberState);
  if (!state || state.event.type === 'member.removed') {
    throw new GroupRefused('Active silo membership required');
  }
  const role = z.object({ role: z.string().optional(), newRole: z.string().optional() });
  const memberData = role.passthrough().parse(state.event.data);
  const currentRole = memberData.newRole ?? memberData.role ?? '';
  if (admin && !['owner', 'admin'].includes(currentRole)) {
    throw new GroupRefused('Owner or Admin required');
  }
  const auth = memberAuthorisation(binding);
  const relation = admin ? 'admin' : 'member';
  const permission = await auth.check(memberId, relation);
  if (permission.status === 'unavailable') throw new Error('IAM unavailable');
  if (!permission.allowed) throw new GroupRefused('Membership unavailable');
  const receiptRows = rows.filter(needsReceipt);
  for (const row of receiptRows) {
    if (!await auth.applied(row.event.id)) {
      throw new GroupRefused('Membership is still being applied');
    }
  }
}

function eventType(input: GroupInput) {
  if (input.action === 'create') return 'team.created';
  if (input.action === 'add') return 'team.member_added';
  return 'team.member_removed';
}
function eventData(input: GroupInput, memberId: string) {
  if (input.action === 'create') {
    return { teamId: input.groupId, name: input.name, createdBy: memberId };
  }
  if (input.action === 'add') {
    return { teamId: input.groupId, memberId: input.memberId, addedBy: memberId };
  }
  return { teamId: input.groupId, memberId: input.memberId, removedBy: memberId };
}
function sameInput(data: Record<string, unknown>, input: GroupInput) {
  if (data['teamId'] !== input.groupId) return false;
  if (input.action === 'create') return data['name'] === input.name;
  return data['memberId'] === input.memberId;
}
function previous(rows: StoredEvent[], input: GroupInput, memberId: string) {
  function matchesCommand(row: StoredEvent) {
    return row.event.commandId === input.commandId;
  }
  const row = rows.find(matchesCommand);
  if (!row) return;
  const data = z.record(z.string(), z.unknown()).parse(row.event.data);
  if (row.event.type !== eventType(input) || row.event.principal?.id !== memberId ||
      !sameInput(data, input)) {
    throw new GroupConflict('Command id already used');
  }
  return {
    status: 'appended' as const, groupId: input.groupId,
    sequence: row.sequence, changeId: row.event.id,
  };
}

/** One conditional append; retry reconciliation uses the stored command and verified identity. */
export async function groupCommand(
  store: EventStore, binding: Binding, memberId: string, raw: unknown,
) {
  const input = groupInput.parse(raw);
  const subject = `team-${input.groupId}`;
  const subjects = [`member-${memberId}`];
  if (input.action !== 'create') subjects.push(`member-${input.memberId}`);
  const fresh = await authorityFence(store, performance.now(), subjects);
  await activeMember(store, binding, memberId, true);
  if (input.action !== 'create') await activeMember(store, binding, input.memberId);
  const rows = await history(store, subject, binding.silo);
  checkHistory(rows, input.groupId);
  const retried = previous(rows, input, memberId);
  if (retried) {
    await fresh();
    return retried;
  }
  editable(rows, input);
  const event = {
    id: randomUUID(), commandId: input.commandId, subject, silo: binding.silo,
    type: eventType(input), data: eventData(input, memberId),
    time: new Date().toISOString(), source: 'opencrane-server',
    principal: { kind: 'human' as const, id: memberId },
  };
  await fresh();
  const expectedSequence = rows.at(-1)?.sequence ?? 0;
  const result = await store.append({ expectedSequence, event });
  if (result.status === 'unavailable') {
    throw new Error('Group append unavailable', { cause: result.cause });
  }
  if (result.status === 'rejected') throw new Error('Group append rejected');
  const updatedRows = await history(store, subject, binding.silo);
  const completed = previous(updatedRows, input, memberId);
  if (completed) return completed;
  throw new GroupConflict('Concurrent group change; reload');
}

function checkHistory(rows: StoredEvent[], groupId: string) {
  for (const row of rows) {
    const data = z.object({ teamId: z.string() }).passthrough().parse(row.event.data);
    if (data.teamId !== groupId) throw new GroupRefused('Group history mismatch');
  }
}
function isCreated(row: StoredEvent) {
  return row.event.type === 'team.created';
}
function editable(rows: StoredEvent[], input: GroupInput) {
  const created = rows.find(isCreated);
  if (input.action === 'create') {
    if (rows.length > 0) throw new GroupConflict('Group already exists');
    return;
  }
  if (!created) throw new GroupConflict('Group unavailable');
  const targetMemberId = input.memberId;
  function matchesMember(row: StoredEvent) {
    if (!row.event.type.startsWith('team.member_')) return false;
    const data = z.object({ memberId: z.string() }).parse(row.event.data);
    return data.memberId === targetMemberId;
  }
  const current = rows.findLast(matchesMember);
  for (const record of [created, current]) {
    if (!record) continue;
    const data = z.object({ membershipSource: z.string().optional() });
    const source = data.passthrough().parse(record.event.data).membershipSource;
    if (source === 'identity_provider') {
      throw new GroupRefused('Membership is managed by the identity provider');
    }
  }
}
