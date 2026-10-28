import type { Binding } from '@opencrane/authz';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
import type { MemoryContextRecord } from '@opencrane/events';
import { AuthorityRefused, MemberAccessRefused, PayingGroupRefused, authorityFence,
  currentMembership, history, loadedMemoryRights, ownershipWriteAccess,
  prepareMemoryReceipts, readActiveMember } from '@opencrane/models';

type Options = { silo: string; store: EventStore; binding?: Binding };

export async function lostMemoryAccess(options: Options, saved: MemoryContextRecord,
  scopeId: string) {
  const { store, binding } = options;
  if (!binding || binding.silo !== options.silo) throw new Error('Memory access unavailable');
  const claims = { silo: options.silo, requester: saved.requesterId,
    assistant: saved.assistantId, computer: saved.computerId, generation: saved.generation,
    conversation: saved.conversationId, turn: saved.turnId, thread: saved.threadId };
  // Read history and receipt facts before starting the short access check.
  const deadline = performance.now() + 10_000;
  const membership = await currentMembership(store, options.silo, saved.requesterId,
    undefined, deadline);
  if (!membership.role) {
    // Preserve saved membership loss even when permission checks are unavailable.
    const fresh = await ownershipWriteAccess(store, membership.positions);
    await fresh();
    return true;
  }
  const rows = await history(store, `conversation-${saved.conversationId}`, options.silo, deadline);
  function grantsAccess(row: StoredEvent) {
    return ['conversation.created', 'participant.added', 'participant.removed']
      .includes(row.event.type);
  }
  const conversation = rows.filter(grantsAccess);
  const applied = await prepareMemoryReceipts(store, binding, claims, conversation,
    [scopeId], [], deadline);
  const fresh = await authorityFence(store, performance.now());
  let lost = false;
  try {
    await loadedMemoryRights(store, binding, claims, scopeId, fresh, conversation, applied);
    await readActiveMember(store, binding, saved.requesterId, 'member', applied);
  } catch (error) {
    if (!(error instanceof AuthorityRefused) && !(error instanceof MemberAccessRefused) &&
        !(error instanceof PayingGroupRefused)) {
      throw error;
    }
    lost = true;
  }
  // Refuse an uncertain result if access changed while permissions were checked.
  await fresh();
  return lost;
}
