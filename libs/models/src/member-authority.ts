import type { EventStore } from '@opencrane/event-store';
import { memberAuthorisation, type Binding } from '@opencrane/authz';
import { AuthorityApplying, authorityFence } from './authority.ts';
import { currentMembership } from './ownership.ts';

export class MemberAccessRefused extends Error {}

/** Pending ownership, role changes and removals deny access until their IAM receipts exist. */
export async function activeMember(
  store: EventStore, binding: Binding, memberId: string,
  options: { requiredRole: 'member' | 'admin'; fresh?: Awaited<ReturnType<typeof authorityFence>> },
) {
  const fresh = options.fresh ?? await authorityFence(store, performance.now());
  await requireMember(store, binding, memberId, options.requiredRole === 'admin', fresh);
  await fresh();
}

export async function readActiveMember(store: EventStore, binding: Binding, memberId: string) {
  await requireMember(store, binding, memberId, false);
}

async function requireMember(
  store: EventStore, binding: Binding, memberId: string, admin: boolean,
  fresh?: Awaited<ReturnType<typeof authorityFence>>,
) {
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
      throw new AuthorityApplying('Membership is still being applied');
    }
  }
}
