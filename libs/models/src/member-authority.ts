import type { EventStore } from '@opencrane/event-store';
import { memberAuthorisation, type Binding } from '@opencrane/authz';
import { authorityFence } from './authority.ts';
import { currentMembership } from './ownership.ts';

export class MemberAccessRefused extends Error {}

/** Pending ownership, role changes and removals deny access until their IAM receipts exist. */
export async function activeMember(
  store: EventStore, binding: Binding, memberId: string, admin = false,
  fresh?: Awaited<ReturnType<typeof authorityFence>>,
) {
  fresh ??= await authorityFence(store, performance.now());
  const membership = await currentMembership(store, binding.silo, memberId, fresh);
  if (!membership.role) {
    throw new MemberAccessRefused('Active silo membership required');
  }
  if (admin && !['owner', 'admin'].includes(membership.role)) {
    throw new MemberAccessRefused('Owner or Admin required');
  }
  const auth = memberAuthorisation(binding);
  const relation = admin ? 'admin' : 'member';
  const permission = await auth.check(memberId, relation);
  if (permission.status === 'unavailable') {
    throw new Error('IAM unavailable');
  }
  if (!permission.allowed) {
    throw new MemberAccessRefused('Membership unavailable');
  }
  for (const row of membership.facts) {
    if (!await auth.applied(row.event.id)) {
      throw new MemberAccessRefused('Membership is still being applied');
    }
  }
  await fresh();
}
