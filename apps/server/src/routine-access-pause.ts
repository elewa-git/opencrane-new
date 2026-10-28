import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { foldRoutineHistory } from '@opencrane/authz';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
import { routineControlSchema, type EventEnvelope, type RoutineState } from '@opencrane/events';
import { history, ownershipWriteAccess, readRoutineRemoval } from '@opencrane/models';

const id = z.string().regex(/^[\w-]{1,200}$/u);
const revision = z.int().positive();
const inputSchema = z.strictObject({ routineId: id, occurrenceId: id,
  expectedPosition: z.int().nonnegative(), expectedDefinitionRevision: revision,
  expectedScheduleRevision: revision, expectedControlRevision: revision,
  cause: z.strictObject({ eventId: z.string().min(1).max(300), position: revision }) });
type Input = z.infer<typeof inputSchema>;

function pauseData(state: RoutineState | undefined, input: Input, position: number) {
  const saved = state?.definition;
  if (!saved || state.activeRun?.occurrenceId !== input.occurrenceId ||
      position !== input.expectedPosition ||
      saved.definitionRevision !== input.expectedDefinitionRevision ||
      saved.scheduleRevision !== input.expectedScheduleRevision ||
      saved.controlRevision !== input.expectedControlRevision) {
    throw new Error('Changed routine');
  }
  const data = { version: 1, routineId: input.routineId,
    definitionRevision: saved.definitionRevision, scheduleRevision: saved.scheduleRevision,
    controlRevision: saved.controlRevision + 1, actorId: 'opencrane-server', source: 'access',
    reason: 'owner_removed', affectedRun: input.occurrenceId, next: saved.next, cause: input.cause };
  return routineControlSchema.parse(data);
}
function receipt(row: StoredEvent, event: EventEnvelope) {
  if (row.event.type !== event.type || row.event.commandId !== event.commandId ||
      row.event.subject !== event.subject || row.event.silo !== event.silo ||
      !isDeepStrictEqual(row.event.principal, event.principal) ||
      !isDeepStrictEqual(row.event.data, event.data)) {
    throw new Error('Changed pause');
  }
  return { status: 'confirmed' as const, eventId: row.event.id, position: row.sequence };
}

/** Save prohibition only. Apply budget Stop and connected interruption separately. */
export async function pauseRoutineAfterRemoval(store: EventStore, silo: string, raw: unknown) {
  try {
    const input = inputSchema.parse(raw);
    const hash = createHash('sha256');
    const identity = [silo, input.routineId, input.occurrenceId, input.cause];
    const identityText = JSON.stringify(identity);
    hash.update(identityText);
    const commandId = `routine-access:${hash.digest('hex')}`;
    const subject = `routine-${input.routineId}`;
    const rows = await history(store, subject, silo, performance.now() + 10_000);
    let state: RoutineState | undefined;
    let position = 0;
    let claimPosition = 0;
    let previous: StoredEvent | undefined;
    const completed = new Map<string, NonNullable<RoutineState['activeRun']>>();
    for (const row of rows) {
      if (row.event.commandId === commandId) {
        previous = row;
        break;
      }
      state = foldRoutineHistory(state, row.event, completed);
      position = row.sequence;
      if (row.event.type === 'routine.due') {
        claimPosition = row.sequence;
      }
    }
    const data = pauseData(state, input, position);
    // Finish routine history before reading the small member stream and starting the write limit.
    const positions = await readRoutineRemoval(store, state, input.cause, claimPosition,
      performance.now() + 10_000);
    const event: EventEnvelope = { id: randomUUID(), commandId, type: 'routine.paused',
      source: 'opencrane-server', silo, subject, principal: { kind: 'system', id: 'opencrane-server' },
      time: new Date().toISOString(), correlation: {}, data };
    if (previous) {
      return receipt(previous, event);
    }
    const access = await ownershipWriteAccess(store, positions);
    const change = { event, expectedSequence: position,
      deadline: access.deadline, historyChecked: true as const, checkAccess: access };
    const result = await store.append(change);
    if (result.status !== 'appended') {
      throw new Error('Pause not saved');
    }
    const row = await store.readEvent(result.sequence, performance.now() + 10_000);
    return receipt(row, event);
  } catch {
    throw new Error('Routine access pause refused');
  }
}
