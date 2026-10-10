import type { EventStore } from '@opencrane/event-store';
import { memberAuthorisation, type Binding } from '@opencrane/authz';
import { authorityFence } from './authority.ts';
import { AuthorityApplying } from './paying-group.ts';
import { currentMembership } from './ownership.ts';

export class MemberAccessRefused extends Error {}

/** Deny access until the access system has applied ownership, role changes and removals. */
export async function activeMember(
  store: EventStore, binding: Binding, memberId: string,
  options: {
    requiredRole: 'member' | 'admin';
    fresh?: Awaited<ReturnType<typeof authorityFence>>;
    membership?: Awaited<ReturnType<typeof currentMembership>>;
  },
) {
  const membership = options.membership ?? await currentMembership(
    store, binding.silo, memberId, undefined, performance.now() + 10_000);
  const subjects = [...membership.positions.keys()];
  const fresh = options.fresh ?? await authorityFence(store, performance.now(), subjects);
  for (const [subject, position] of membership.positions) {
    fresh.include(subject);
    if (await store.head(subject, fresh.deadline) !== position) {
      throw new Error('Authority changed');
    }
  }
  await requireMember(binding, memberId, options.requiredRole === 'admin', membership);
  await fresh();
}

export async function readActiveMember(store: EventStore, binding: Binding, memberId: string,
  requiredRole: 'member' | 'admin' = 'member',
  applied?: (eventId: string) => Promise<boolean>,
) {
  const membership = await currentMembership(store, binding.silo, memberId,
    undefined, performance.now() + 10_000);
  await requireMember(binding, memberId, requiredRole === 'admin', membership, applied);
}

async function requireMember(
  binding: Binding, memberId: string, admin: boolean,
  membership: Awaited<ReturnType<typeof currentMembership>>,
  applied?: (eventId: string) => Promise<boolean>,
) {
  if (!membership.role) {
    throw new MemberAccessRefused('Active silo membership required');
  }
  if (admin && !['owner', 'admin'].includes(membership.role)) {
    throw new MemberAccessRefused('Owner or Admin required');
  }
  const auth = memberAuthorisation(binding);
  const checkApplied = applied ?? auth.applied.bind(auth);
  const relation = admin ? 'admin' : 'member';
  const permission = await auth.check(memberId, relation);
  if (permission.status === 'unavailable') {
    throw new Error('IAM unavailable');
  }
  if (!permission.allowed) {
    throw new MemberAccessRefused('Membership unavailable');
  }
  for (const row of membership.facts) {
    if (!await checkApplied(row.event.id)) {
      throw new AuthorityApplying('Membership is still being applied');
    }
  }
}
