import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { foldRoutineHistory, memberAuthorisation, type Binding } from '@opencrane/authz';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
import { routineControlSchema, type EventEnvelope,
  type RoutineState } from '@opencrane/events';
import { ownershipWriteAccess } from '@opencrane/models';

const id = z.string().regex(/^[\w-]{1,200}$/u);
const revision = z.int().positive();
const inputSchema = z.strictObject({
  changeId: z.string().regex(/^[\w-]{1,200}:[\w-]{1,200}$/u), routineId: id,
  expectedPosition: z.int().nonnegative(), expectedDefinitionRevision: revision,
  expectedScheduleRevision: revision, expectedControlRevision: revision,
});
type Input = z.infer<typeof inputSchema>;
class PauseConflict extends Error {
  constructor() {
    super('Routine pause conflict');
  }
}
class PauseRefused extends Error {
  constructor() {
    super('Routine pause refused');
  }
}

function receipt(row: StoredEvent, changeId: string) {
  return { status: 'confirmed' as const, changeId, eventId: row.event.id,
    position: row.sequence };
}

function requireRevisions(input: Input, state: RoutineState | undefined, position: number) {
  const saved = state?.definition;
  if (!saved || input.expectedPosition !== position ||
      input.expectedDefinitionRevision !== saved.definitionRevision ||
      input.expectedScheduleRevision !== saved.scheduleRevision ||
      input.expectedControlRevision !== saved.controlRevision) {
    throw new PauseConflict();
  }
}

function pauseData(state: RoutineState | undefined) {
  const saved = state?.definition;
  if (!saved || state.status === 'retired') {
    throw new PauseRefused();
  }
  const data = { version: 1, routineId: state.routineId,
    definitionRevision: saved.definitionRevision, scheduleRevision: saved.scheduleRevision,
    controlRevision: saved.controlRevision + 1, actorId: saved.definition.ownerId,
    source: 'owner', reason: 'owner_requested', affectedRun: state.activeRun?.occurrenceId ?? null, next: saved.next };
  return routineControlSchema.parse(data);
}

function requireSamePause(event: EventEnvelope, input: Input, memberId: string,
  data: ReturnType<typeof pauseData>) {
  const saved = routineControlSchema.safeParse(event.data);
  if (event.type !== 'routine.paused' || event.commandId !== input.changeId ||
      event.subject !== `routine-${input.routineId}` ||
      event.principal?.kind !== 'human' || event.principal.id !== memberId ||
      !saved.success || JSON.stringify(saved.data) !== JSON.stringify(data)) {
    throw new PauseConflict();
  }
}

function previousPause(rows: StoredEvent[], input: Input, memberId: string) {
  let state: RoutineState | undefined;
  let position = 0;
  const completed = new Map<string, NonNullable<RoutineState['activeRun']>>();
  for (const row of rows) {
    if (row.event.commandId === input.changeId) {
      requireRevisions(input, state, position);
      requireSamePause(row.event, input, memberId, pauseData(state));
      return receipt(row, input.changeId);
    }
    state = foldRoutineHistory(state, row.event, completed);
    position = row.sequence;
  }
  return undefined;
}

/** Save the pause and occupied run; budget cleanup uses this event separately. */
export async function pauseRoutine(store: EventStore, binding: Binding,
  memberId: string, raw: unknown) {
  try {
    const input = inputSchema.parse(raw);
    // Bind the reference to its target even after the transport forgets duplicate ids.
    if (!input.changeId.startsWith(`${input.routineId}:`)) {
      throw new PauseConflict();
    }
    const auth = memberAuthorisation(binding, store);
    const saved = await auth.loadRoutineAccess(memberId, input.routineId);
    // Refuse non-owners before revealing saved changes or revision conflicts.
    if (!(await saved.check('manage')).allowed) {
      throw new PauseRefused();
    }
    const previous = previousPause(saved.rows, input, memberId);
    if (previous) {
      if (!(await saved.check('manage')).allowed) {
        throw new PauseRefused();
      }
      return previous;
    }
    const data = pauseData(saved.state);
    if (data.actorId !== memberId) {
      throw new PauseRefused();
    }
    const position = saved.rows.at(-1)?.sequence ?? 0;
    requireRevisions(input, saved.state, position);
    const event: EventEnvelope = { id: randomUUID(), commandId: input.changeId,
      type: 'routine.paused', source: 'opencrane-server', silo: binding.silo,
      subject: `routine-${input.routineId}`, principal: { kind: 'human', id: data.actorId },
      time: new Date().toISOString(), correlation: {}, data };
    // Finish history reads before starting the original two-second access limit.
    const fresh = await ownershipWriteAccess(store, saved.positions);
    if (!(await saved.check('manage')).allowed) {
      throw new PauseRefused();
    }
    const change = { event, expectedSequence: position, deadline: fresh.deadline,
      historyChecked: true as const, checkAccess: fresh };
    const result = await store.append(change);
    if (result.status === 'conflict' || result.status === 'rejected') {
      throw new PauseConflict();
    }
    if (result.status !== 'appended') {
      throw new Error('Append unavailable');
    }
    // Compare the saved change because a concurrent request may have used this id first.
    const row = await store.readEvent(result.sequence, performance.now() + 10_000);
    requireSamePause(row.event, input, memberId, data);
    return receipt(row, input.changeId);
  } catch (error) {
    if (error instanceof PauseConflict || error instanceof PauseRefused) {
      throw error;
    }
    // eslint-disable-next-line preserve-caught-error -- Keep private service details out of replies.
    throw new Error('Routine pause unavailable');
  }
}
