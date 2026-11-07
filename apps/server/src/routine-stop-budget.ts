import { z } from 'zod';
import { computerSummary } from '@opencrane/auth';
import { computerTurnClosedDataSchema, type RoutineState } from '@opencrane/events';
import { readStreamSummary, readEventAt } from '@opencrane/event-store';
import { finishRoutine } from './routine-finish.ts';
import type { EventStore } from '@opencrane/event-store';
import { readRootStopEvidence, type BudgetActor } from '@opencrane/models';

type Options = { enabled?: boolean; replay?: boolean; requireCurrent?: () => Promise<void> };
type Run = NonNullable<RoutineState['activeRun']>;

const referenceSchema = z.strictObject({ routineId: z.string().regex(/^[\w-]{1,200}$/u),
  eventId: z.string().min(1).max(300), position: z.int().positive() });

/** Apply saved Stop, Pause or Retire intent only in explicitly enabled live work. */
export async function applyRoutineStop(store: EventStore, silo: string, raw: unknown,
  actor: BudgetActor, options: Options = {}) {
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
    await options.requireCurrent?.();
    await actor.stopRoot(root.rootId, 'routine_stop', subject, source.sequence);
    await finishClosedRun(store, silo, run, options);
    return { status: 'confirmed' as const };
  } catch {
    throw new Error('Routine budget Stop unavailable');
  }
}

async function finishClosedRun(store: EventStore, silo: string, run: Run, options: Options) {
  const computerSubject = `computer-${run.definition.assistantId}`;
  function closedPosition(summary: Parameters<typeof computerSummary.add>[0]) {
    return summary.turns.get(run.turnId)?.firstClose?.sequence;
  }
  const deadline = performance.now() + 10_000;
  const position = await readStreamSummary(store, silo, computerSubject,
    computerSummary, deadline, closedPosition);
  if (position === undefined) {
    return;
  }
  const closed = await readEventAt(store, computerSubject, position, deadline);
  if (!closed) {
    throw new Error('Closure unavailable');
  }
  const terminal = computerTurnClosedDataSchema.parse(closed.event.data);
  if (terminal.task !== 'chat_turn' || terminal.nativeTermination !== 'turn_completed') {
    return;
  }
  const input = { routineId: run.routineId, occurrenceId: run.occurrenceId,
    terminalEvidence: { eventId: closed.event.id, position } };
  await finishRoutine(store, silo, input, options);
}
