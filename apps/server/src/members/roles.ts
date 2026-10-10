import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { memberRoleChangedDataSchema, ownershipTransferredSchema,
  ownershipConfirmedSchema } from '@opencrane/events';
import { memberAuthorisation } from '@opencrane/authz';
import type { StoredEvent } from '@opencrane/event-store';
import { activeMember, authorityFence, currentMembership, history, ownershipState,
  readActiveMember, MemberAccessRefused } from '@opencrane/models';
import type { GroupOptions } from './group-routes.ts';

const identifier = z.string().regex(/^[\w-]{1,200}$/u);
export const roleParams = z.object({ memberId: identifier, commandId: identifier.optional() });
const roleBody = z.object({ commandId: identifier, newRole: z.enum(['member', 'admin']),
  expectedSequence: z.int().nonnegative().safe() }).strict();
type Input = z.infer<typeof roleBody>;
export class RoleConflict extends Error {}

function receipt(row: StoredEvent) {
  const data = memberRoleChangedDataSchema.parse(row.event.data);
  return { status: 'recorded' as const, commandId: row.event.commandId,
    changeId: row.event.id, type: row.event.type, sequence: row.sequence,
    recordedAt: row.event.time, memberId: data.memberId, newRole: data.newRole };
}
function previous(rows: StoredEvent[], actor: string, input: Input) {
  function matches(row: StoredEvent) {
    return row.event.commandId === input.commandId;
  }
  const index = rows.findIndex(matches);
  const row = rows[index];
  if (!row) return undefined;
  if (row.event.type !== 'member.role_changed') throw new RoleConflict('command_id_reused');
  const data = memberRoleChangedDataSchema.parse(row.event.data);
  if (row.event.principal?.kind !== 'human'
    || row.event.principal.id !== actor || data.changedBy !== actor
    || data.newRole !== input.newRole
    || (rows[index - 1]?.sequence ?? 0) !== input.expectedSequence) {
    throw new RoleConflict('command_id_reused');
  }
  return receipt(row);
}
export async function roleCommand(options: GroupOptions, actor: string, memberId: string,
  raw: unknown) {
  const input = roleBody.parse(raw);
  const { store, binding, silo } = options;
  await readActiveMember(store, binding, actor, 'admin');
  const subject = `member-${memberId}`;
  const rows = await history(store, subject, silo, performance.now() + 10_000);
  const saved = previous(rows, actor, input);
  if (saved) return saved;
  if ((rows.at(-1)?.sequence ?? 0) !== input.expectedSequence) {
    throw new RoleConflict('concurrent_change');
  }
  const deadline = performance.now() + 10_000;
  const target = await currentMembership(store, silo, memberId, undefined, deadline);
  if (target.role === 'owner') throw new RoleConflict('ownership_stream_required');
  if (!target.role) throw new RoleConflict('active_target_required');
  if (target.role === input.newRole) throw new RoleConflict('role_unchanged');
  // Finish history reads before starting the short write access check.
  const subjects = [`member-${actor}`, subject, `ownership-${silo}`];
  const fresh = await authorityFence(store, performance.now(), subjects);
  const authority = { requiredRole: 'admin' as const, fresh };
  await activeMember(store, binding, actor, authority);
  const targetPosition = await store.head(subject, fresh.deadline);
  const ownershipPosition = await store.head(`ownership-${silo}`, fresh.deadline);
  if (targetPosition !== input.expectedSequence
    || ownershipPosition !== (target.ownership.at(-1)?.sequence ?? 0)) {
    throw new RoleConflict('concurrent_change');
  }
  const data = { memberId, previousRole: target.role, newRole: input.newRole, changedBy: actor };
  const event = { id: randomUUID(), commandId: input.commandId, subject, silo,
    type: 'member.role_changed', source: 'opencrane-server', time: new Date().toISOString(),
    principal: { kind: 'human' as const, id: actor }, data };
  await fresh();
  const command = { event, expectedSequence: input.expectedSequence,
    deadline: fresh.deadline, historyChecked: true as const };
  const result = await store.append(command);
  if (result.status === 'unavailable' || result.status === 'rejected') {
    throw new Error('Role append unavailable');
  }
  const updated = await history(store, subject, silo, performance.now() + 10_000);
  const completed = previous(updated, actor, input);
  if (completed) return completed;
  throw new RoleConflict('concurrent_change');
}
export async function roleStatus(options: GroupOptions, actor: string, memberId: string,
  commandId: string) {
  const { store, binding, silo } = options;
  const rows = await history(store, `member-${memberId}`, silo, performance.now() + 10_000);
  function matches(row: StoredEvent) {
    return row.event.type === 'member.role_changed' && row.event.commandId === commandId;
  }
  const row = rows.find(matches);
  const deadline = performance.now() + 10_000;
  const membership = await currentMembership(store, silo, actor, undefined, deadline);
  const auth = memberAuthorisation(binding);
  if (membership.role === 'member') {
    if (!ownsDemotion(row, actor, memberId)) {
      throw new MemberAccessRefused('Owner or Admin required');
    }
    // Allow the original actor's receipt while this demotion is still being applied.
    const demotionId = row?.event.id;
    async function applied(eventId: string) {
      if (eventId === demotionId) return true;
      return auth.applied(eventId);
    }
    await readActiveMember(store, binding, actor, 'member', applied);
  } else {
    await readActiveMember(store, binding, actor, 'admin');
  }
  if (!row) return { status: 'not_found', commandId };
  const ownership = await history(store, `ownership-${silo}`, silo, performance.now() + 10_000);
  const changeSequence = row.sequence;
  function beforeChange(change: StoredEvent) {
    return change.sequence < changeSequence;
  }
  const target = await currentMembership(store, silo, memberId,
    undefined, performance.now() + 10_000);
  const earlier = ownership.filter(beforeChange);
  const earlierConfirmations = target.confirmations.filter(beforeChange);
  const ownersAtChange = ownershipState(earlier, earlierConfirmations);
  const currentOwners = target.owners;
  const effect = ownersAtChange.has(memberId) || currentOwners.has(memberId)
    ? 'none_target_became_owner' : 'role_changed';
  function targetsMember(change: StoredEvent) {
    return change.event.type === 'ownership.transferred'
      && ownershipTransferredSchema.parse(change.event.data).memberId === memberId;
  }
  let appointment = ownership.findLast(targetsMember);
  if (appointment && ownershipTransferredSchema.parse(appointment.event.data).awaitingConfirmation) {
    const requestId = appointment.event.id;
    function confirmsRequest(change: StoredEvent) {
      return ownershipConfirmedSchema.parse(change.event.data).appointmentId === requestId;
    }
    appointment = target.confirmations.find(confirmsRequest);
  }
  const projection = await projectionProgress(options, row, appointment);
  return { ...receipt(row), effect, projection };
}

function ownsDemotion(row: StoredEvent | undefined, actor: string, memberId: string) {
  if (!row || memberId !== actor || row.event.principal?.kind !== 'human'
    || row.event.principal.id !== actor) return false;
  const data = memberRoleChangedDataSchema.parse(row.event.data);
  return data.newRole === 'member';
}

async function projectionProgress(options: GroupOptions, row: StoredEvent,
  appointment: StoredEvent | undefined) {
  const auth = memberAuthorisation(options.binding);
  const requiredPosition = Math.max(row.sequence, appointment?.sequence ?? 0);
  const checkpoint = await options.db.query<{ sequence: string }>(
    'SELECT sequence FROM projection_checkpoints WHERE name = $1', ['members']);
  const content = Number(checkpoint.rows[0]?.sequence ?? 0) >= requiredPosition
    ? 'current' : 'applying';
  let iamApplied = await auth.applied(row.event.id);
  if (appointment) {
    iamApplied = iamApplied && await auth.applied(appointment.event.id);
  }
  const iam = iamApplied ? 'current' : 'applying';
  return { content, iam };
}
