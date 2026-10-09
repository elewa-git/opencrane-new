import { randomUUID } from 'node:crypto';
import { legacyMemberRole } from '@opencrane/events';
import { z } from 'zod';
import { memberAuthorisation, type Binding } from '@opencrane/authz';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
import { authorityFence, currentMembership, history, ownershipSubject,
  ownershipState } from '@opencrane/models';

const identifier = z.string().regex(/^[\w-]{1,200}$/u);
const common = { commandId: identifier, expectedSequence: z.int().nonnegative().safe() };
const commandSchema = z.discriminatedUnion('action', [
  z.object({ ...common, action: z.literal('transfer'), successorId: identifier }).strict(),
  z.object({ ...common, action: z.literal('step_down') }).strict(),
]);
type Command = z.infer<typeof commandSchema>;
export class OwnershipRefused extends Error {}
export class OwnershipConflict extends Error {}

type FreshAuthority = Awaited<ReturnType<typeof authorityFence>>;
export async function ownershipAccess(store: EventStore, binding: Binding, memberId: string,
  fresh: FreshAuthority) {
  const membership = await readableMembership(store, binding, memberId, fresh);
  await checkReceipts(binding, memberId, membership.facts, 'admin');
  return membership;
}
export async function ownershipStatusAccess(store: EventStore, binding: Binding, memberId: string,
  fresh: FreshAuthority) {
  const membership = await readableMembership(store, binding, memberId, fresh);
  // Skip step-down events when checking saved permissions, so either side can
  // still read status after a step-down. Adding an owner still needs OpenFGA's
  // permission record.
  const facts = membership.facts.filter(isStatusAuthority);
  await checkReceipts(binding, memberId, facts, 'admin');
  return membership;
}
async function readableMembership(store: EventStore, binding: Binding, memberId: string,
  fresh: FreshAuthority) {
  const membership = await currentMembership(store, binding.silo, memberId, fresh);
  if (!['owner', 'admin'].includes(membership.role)) {
    throw new OwnershipRefused('owner_or_admin_required');
  }
  return membership;
}
function isStatusAuthority(row: StoredEvent) {
  return row.event.type !== 'ownership.stepped_down';
}
async function checkReceipts(binding: Binding, memberId: string, facts: StoredEvent[],
  relation: 'admin' | 'member') {
  const auth = memberAuthorisation(binding);
  const permission = await auth.check(memberId, relation);
  if (permission.status === 'unavailable') {
    throw new Error('IAM unavailable');
  }
  if (!permission.allowed) {
    throw new OwnershipRefused('access_changed');
  }
  for (const row of facts) {
    if (!await auth.applied(row.event.id)) {
      throw new Error('IAM projection behind');
    }
  }
}
function commandType(input: Command) {
  if (input.action === 'transfer') {
    return 'ownership.transferred';
  }
  return 'ownership.stepped_down';
}
function payload(input: Command, actorId: string) {
  if (input.action === 'transfer') {
    return { memberId: input.successorId, transferredBy: actorId };
  }
  return { memberId: actorId };
}
export function ownershipReceipt(row: StoredEvent) {
  return { status: 'appended' as const, commandId: row.event.commandId,
    changeId: row.event.id, sequence: row.sequence, recordedAt: row.event.time,
    actorId: row.event.principal?.id, type: row.event.type, data: row.event.data };
}
function previous(rows: StoredEvent[], input: Command, actorId: string) {
  function hasCommand(row: StoredEvent) {
    return row.event.commandId === input.commandId;
  }
  const row = rows.find(hasCommand);
  if (!row) {
    return;
  }
  const fields = z.record(z.string(), z.unknown()).parse(row.event.data);
  const expected = payload(input, actorId);
  const precedingSequence = rows[rows.indexOf(row) - 1]?.sequence ?? 0;
  if (row.event.type !== commandType(input) || row.event.principal?.id !== actorId ||
      fields['memberId'] !== expected.memberId || precedingSequence !== input.expectedSequence) {
    throw new OwnershipConflict('command_id_reused');
  }
  return ownershipReceipt(row);
}

/** All owner edits use this conditional stream append; stepping down always becomes Admin. */
export async function ownershipCommand(store: EventStore, binding: Binding,
  actorId: string, raw: unknown) {
  const input = commandSchema.parse(raw);
  const subject = ownershipSubject(binding.silo);
  const fresh = await authorityFence(store, performance.now(), [subject, `member-${actorId}`]);
  const membership = await ownershipAccess(store, binding, actorId, fresh);
  const rows = membership.ownership;
  if (!rows.length) {
    throw new Error('Ownership migration required');
  }
  const retried = previous(rows, input, actorId);
  if (retried) {
    await fresh();
    return retried;
  }
  if (!membership.owners.has(actorId)) {
    throw new OwnershipRefused('owner_required');
  }
  if ((rows.at(-1)?.sequence ?? 0) !== input.expectedSequence) {
    throw new OwnershipConflict('concurrent_change');
  }
  if (input.action === 'transfer') {
    const successor = await currentMembership(store, binding.silo, input.successorId, fresh);
    if (!successor.role) {
      throw new OwnershipRefused('active_successor_required');
    }
    await checkReceipts(binding, input.successorId, successor.facts, 'member');
    if (membership.owners.has(input.successorId)) {
      throw new OwnershipConflict('already_owner');
    }
  } else {
    const anotherActiveOwner = await hasAnotherActiveOwner(
      store, binding.silo, actorId, membership.owners, fresh);
    if (!anotherActiveOwner) throw new OwnershipConflict('last_owner');
  }
  const event = {
    id: randomUUID(), commandId: input.commandId, subject, silo: binding.silo,
    type: commandType(input), data: payload(input, actorId),
    time: new Date().toISOString(), source: 'opencrane-server', correlation: {},
    principal: { kind: 'human' as const, id: actorId },
  };
  // Recheck the successor's membership before appending the ownership change.
  // This catches a removal that happened after the earlier membership read.
  await fresh();
  const result = await store.append({ event, expectedSequence: input.expectedSequence });
  if (result.status === 'unavailable') {
    throw new Error('Ownership append unavailable', { cause: result.cause });
  }
  if (result.status === 'rejected') {
    throw new Error('Ownership append rejected');
  }
  const updated = await history(store, subject, binding.silo, performance.now() + 2000);
  ownershipState(updated);
  const receipt = previous(updated, input, actorId);
  if (receipt) {
    return receipt;
  }
  throw new OwnershipConflict('concurrent_change');
}

async function hasAnotherActiveOwner(store: EventStore, silo: string, actorId: string,
  owners: Set<string>, fresh: FreshAuthority) {
  for (const ownerId of owners) {
    if (ownerId === actorId) continue;
    fresh.include(`member-${ownerId}`);
    const rows = await history(store, `member-${ownerId}`, silo, fresh.deadline);
    let active = false;
    for (const row of rows) {
      const role = legacyMemberRole(row.event);
      if (role !== undefined) active = role !== '';
    }
    if (active) return true;
  }
  return false;
}
