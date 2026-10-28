import { z } from 'zod';
import type { EventStore } from '@opencrane/event-store';
import { readRootStopEvidence, type BudgetActor } from '@opencrane/models';

const referenceSchema = z.strictObject({ routineId: z.string().regex(/^[\w-]{1,200}$/u),
  eventId: z.string().min(1).max(300), position: z.int().positive() });

/** Apply saved Stop, Pause or Retire intent only in explicitly enabled live work. */
export async function applyRoutineStop(store: EventStore, silo: string, raw: unknown,
  actor: BudgetActor, options: { enabled?: boolean; replay?: boolean } = {}) {
  if (options.enabled !== true || options.replay === true) {
    return { status: 'disabled' as const };
  }
  try {
    if (actor.store !== store || actor.silo !== silo) {
      throw new Error('Actor mismatch');
    }
    const reference = referenceSchema.parse(raw);
    const subject = `routine-${reference.routineId}`;
    const source = await readRootStopEvidence(store, subject, reference.position);
    const run = source.routine?.activeRun;
    if (!run || source.event.silo !== silo || source.event.id !== reference.eventId) {
      throw new Error('Source mismatch');
    }
    const { conversationId, turnId, definition } = run;
    function matches(root: BudgetActor['state']['roots'][number]) {
      return root.conversationId === conversationId && root.turnId === turnId &&
        root.requesterId === definition.ownerId &&
        root.assistantId === definition.assistantId &&
        root.payingGroupId === definition.payingGroupId;
    }
    const root = actor.state.roots.find(matches);
    // Keep intent when allocation has not finished. Never create capacity for cleanup.
    if (!root) {
      return { status: 'pending' as const };
    }
    await actor.stopRoot(root.rootId, 'routine_stop', subject, source.sequence);
    return { status: 'confirmed' as const };
  } catch {
    throw new Error('Routine budget Stop unavailable');
  }
}
