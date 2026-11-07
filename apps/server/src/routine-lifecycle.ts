import { foldRoutineHistory } from '@opencrane/authz';
import { conversationCreatedDataSchema, type RoutineState } from '@opencrane/events';
import { history, type BudgetActor } from '@opencrane/models';
import { readChatFacts } from './chat/chat-summary.ts';
import { affectedRoutineOccurrence } from './routine-bridge.ts';
import { applyRoutineStop } from './routine-stop-budget.ts';

async function reconcileRoot(actor: BudgetActor, root: BudgetActor['state']['roots'][number],
  requireCurrent: () => Promise<void>) {
  const chat = await readChatFacts(actor.store, actor.silo, root.conversationId, root.turnId);
  const created = conversationCreatedDataSchema.parse(chat.created);
  if (!('routinePreparation' in created) || !created.routinePreparation) {
    return;
  }
  const preparation = created.routinePreparation;
  const subject = `routine-${preparation.routineId}`;
  const rows = await history(actor.store, subject, actor.silo, performance.now() + 10_000);
  let state: RoutineState | undefined;
  const completed = new Map<string, NonNullable<RoutineState['activeRun']>>();
  let source;
  for (const row of rows) {
    state = foldRoutineHistory(state, row.event, completed);
    const affected = affectedRoutineOccurrence(row.event.type, row.event.data);
    if (!source && affected === preparation.occurrenceId) {
      source = row;
    }
  }
  if (!source || state?.activeRun?.occurrenceId !== preparation.occurrenceId ||
      state.activeRun.conversationId !== root.conversationId ||
      state.activeRun.turnId !== root.turnId) {
    return;
  }
  const reference = { routineId: preparation.routineId,
    eventId: source.event.id, position: source.sequence };
  const cleanupOptions = { enabled: true, requireCurrent };
  await applyRoutineStop(actor.store, actor.silo, reference, actor, cleanupOptions);
}

/** Reconcile saved work with the existing budget leader. Never admit or dispatch a turn. */
export function routineLifecycle(actor: BudgetActor, requireCurrent: () => Promise<void>,
  options: { enabled?: boolean; replay?: boolean } = {}) {
  let previousPosition: number | undefined;
  async function poll() {
    if (options.enabled !== true || options.replay === true) {
      return;
    }
    await requireCurrent();
    const position = await actor.store.head();
    if (position === previousPosition) {
      return;
    }
    let complete = true;
    for (const root of actor.state.roots) {
      if (!root.preparationDigest) {
        continue;
      }
      try {
        await requireCurrent();
        await reconcileRoot(actor, root, requireCurrent);
      } catch {
        // Retry saved evidence next time, without blocking another root's cleanup.
        complete = false;
      }
    }
    if (complete) {
      previousPosition = position;
    }
  }
  return { poll };
}
