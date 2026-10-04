import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
import { memberAuthorisation, type Binding } from '@opencrane/authz';
import { authorityFence, history } from '@opencrane/models';

const id = z.string().regex(/^[\w-]{1,200}$/u);
const groupInput = z.discriminatedUnion('action', [
  z.object({ action: z.literal('create'), commandId: id, groupId: id, name: z.string().trim().min(1).max(200).refine(value => !value.includes('\0')) }).strict(),
  z.object({ action: z.enum(['add', 'remove']), commandId: id, groupId: id, memberId: id }).strict(),
]);
type GroupInput = z.infer<typeof groupInput>;
export class GroupRefused extends Error {}
export class GroupConflict extends Error {}

/** Check event truth and atomic IAM receipts, including pending role changes and removals. */
export async function activeMember(store: EventStore, binding: Binding, memberId: string, admin = false) {
  const rows = await history(store, `member-${memberId}`, binding.silo);
  const state = rows.findLast(r => ['member.joined', 'member.role_changed', 'member.removed'].includes(r.event.type));
  const data = z.object({ role: z.string().optional(), newRole: z.string().optional() }).passthrough().parse(state?.event.data ?? {});
  if (!state || state.event.type === 'member.removed') throw new GroupRefused('Active silo membership required');
  if (admin && !['owner', 'admin'].includes(data.newRole ?? data.role ?? '')) throw new GroupRefused('Owner or Admin required');
  const auth = memberAuthorisation(binding);
  const [permission, ...receipts] = await Promise.all([
    auth.check(memberId, admin ? 'admin' : 'member'),
    ...rows.filter(r => r.event.type !== 'member.invited').map(r => auth.applied(r.event.id).then(allowed => ({ allowed }))),
  ]);
  if (permission.status === 'unavailable') throw new Error('IAM unavailable');
  if (!permission.allowed || receipts.some(r => !r.allowed)) throw new GroupRefused('Membership unavailable or still being applied');
}
function previous(rows: StoredEvent[], input: GroupInput, memberId: string) {
  const row = rows.find(r => r.event.commandId === input.commandId);
  if (!row) return;
  const d = z.record(z.string(), z.unknown()).parse(row.event.data);
  const type = input.action === 'create' ? 'team.created' : input.action === 'add' ? 'team.member_added' : 'team.member_removed';
  if (row.event.type !== type || row.event.principal?.id !== memberId || d['teamId'] !== input.groupId ||
    (input.action === 'create' ? d['name'] !== input.name : d['memberId'] !== input.memberId)) throw new GroupConflict('Command id already used');
  return { status: 'appended' as const, groupId: input.groupId, sequence: row.sequence, changeId: row.event.id };
}
/** One conditional append to the existing team stream. The caller supplies verified identity. */
export async function groupCommand(store: EventStore, binding: Binding, memberId: string, raw: unknown) {
  const input = groupInput.parse(raw), subject = `team-${input.groupId}`;
  const fresh = await authorityFence(store, performance.now(), [`member-${memberId}`, ...(input.action !== 'create' ? [`member-${input.memberId}`] : [])]);
  await activeMember(store, binding, memberId, true);
  if (input.action !== 'create') await activeMember(store, binding, input.memberId);
  const rows = await history(store, subject, binding.silo);
  if (rows.some(r => z.object({ teamId: z.string() }).passthrough().parse(r.event.data).teamId !== input.groupId)) throw new GroupRefused('Group history mismatch');
  const retried = previous(rows, input, memberId);
  if (retried) { await fresh(); return retried; }
  editable(rows, input);
  const type = input.action === 'create' ? 'team.created' : input.action === 'add' ? 'team.member_added' : 'team.member_removed';
  const data = input.action === 'create' ? { teamId: input.groupId, name: input.name, createdBy: memberId }
    : { teamId: input.groupId, memberId: input.memberId, ...(input.action === 'add' ? { addedBy: memberId } : { removedBy: memberId }) };
  await fresh();
  const result = await store.append({ expectedSequence: rows.at(-1)?.sequence ?? 0, event: {
    id: randomUUID(), commandId: input.commandId, subject, silo: binding.silo, type, data,
    time: new Date().toISOString(), source: 'opencrane-server', principal: { kind: 'human', id: memberId },
  } });
  if (result.status === 'unavailable') throw new Error('Group append unavailable', { cause: result.cause });
  if (result.status === 'rejected') throw new Error('Group append rejected');
  const completed = previous(await history(store, subject, binding.silo), input, memberId);
  if (completed) return completed;
  throw new GroupConflict('Concurrent group change; reload');
}

function editable(rows: StoredEvent[], input: GroupInput) {
  const created = rows.find(r => r.event.type === 'team.created');
  if (input.action === 'create' ? rows.length > 0 : !created) throw new GroupConflict('Group unavailable or already exists');
  if (input.action !== 'create') {
    const current = rows.findLast(r => r.event.type.startsWith('team.member_') && z.object({ memberId: z.string() }).parse(r.event.data).memberId === input.memberId);
    for (const record of [created, current]) {
      if (record && z.object({ membershipSource: z.string().optional() }).passthrough().parse(record.event.data).membershipSource === 'identity_provider') throw new GroupRefused('Membership is managed by the identity provider');
    }
  }
}
