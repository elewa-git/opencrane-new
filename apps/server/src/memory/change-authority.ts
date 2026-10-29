import { AuthorityRefused, currentMembership, isAuthorityChanged, MemberAccessRefused }
  from '@opencrane/models';
import type { StoredEvent } from '@opencrane/event-store';
import { MemoryRefused, type MemoryOptions } from './access.ts';

export type WriteAuthority = (() => Promise<unknown>) & { deadline: number };
export type AgentChange = { rows: StoredEvent[]; checkAccess: WriteAuthority;
  confirm: () => Promise<unknown>; conversation: string; turn: string; requestId: string };

export function changeRefused(error: unknown): error is Error {
  return error instanceof MemoryRefused || error instanceof MemberAccessRefused ||
    error instanceof AuthorityRefused || isAuthorityChanged(error);
}
async function requireChangeMember(options: MemoryOptions, requester: string, deadline: number) {
  const membership = await currentMembership(options.store, options.silo, requester,
    undefined, deadline);
  if (!membership.role) {
    throw new MemberAccessRefused('Active silo membership required');
  }
}
export async function confirmChange(options: MemoryOptions, requester: string,
  fresh: WriteAuthority, agent?: AgentChange) {
  if (!agent) {
    await fresh();
    return;
  }
  // Check saved membership before a failed dependency can hide a removal.
  await requireChangeMember(options, requester, fresh.deadline);
  try {
    await fresh();
    await agent.confirm();
  } catch (error) {
    // Catch removals saved during the check without repeating permission checks.
    await requireChangeMember(options, requester, fresh.deadline);
    throw error;
  }
}
