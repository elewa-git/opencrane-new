import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
import type { Binding } from '@opencrane/authz';
import { authorityFence, history, activeMember, readActiveMember,
  MemberAccessRefused as GroupRefused } from '@opencrane/models';

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
export { GroupRefused, activeMember, readActiveMember };
export class GroupConflict extends Error {}

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
  const administratorAuthority = { requiredRole: 'admin' as const, fresh };
  await activeMember(store, binding, memberId, administratorAuthority);
  if (input.action !== 'create') {
    const memberAuthority = { requiredRole: 'member' as const, fresh };
    await activeMember(store, binding, input.memberId, memberAuthority);
  }
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
