import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { foldRoutineHistory } from '@opencrane/authz';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
import { routineStopSchema, type EventEnvelope, type RoutineState } from '@opencrane/events';
import { history, readRootStopEvidence, readRoutineApproval } from '@opencrane/models';

const id = z.string().regex(/^[\w-]{1,200}$/u);
const revision = z.int().positive();
const inputSchema = z.strictObject({ routineId: id, occurrenceId: id,
  expectedPosition: z.int().nonnegative(), expectedDefinitionRevision: revision,
  expectedScheduleRevision: revision, expectedControlRevision: revision,
  cause: z.strictObject({ eventId: z.string().min(1).max(300), position: revision }) });
function receipt(row: StoredEvent) {
  return { status: 'confirmed' as const, eventId: row.event.id, position: row.sequence };
}

async function checkedReceipt(store: EventStore, subject: string, row: StoredEvent,
  commandId: string, deadline: number) {
  const stop = routineStopSchema.parse(row.event.data);
  if (row.event.type !== 'routine.run_stop_requested' || stop.source !== 'approval' ||
      row.event.commandId !== commandId) {
    throw new Error('Changed Stop');
  }
  await readRootStopEvidence(store, subject, row.sequence, deadline);
  return receipt(row);
}

function requireRun(state: RoutineState | undefined, input: z.infer<typeof inputSchema>,
  position: number, silo: string) {
  const run = state?.activeRun;
  if (!state || !run || state.silo !== silo || run.occurrenceId !== input.occurrenceId ||
      position !== input.expectedPosition ||
      run.definitionRevision !== input.expectedDefinitionRevision ||
      run.scheduleRevision !== input.expectedScheduleRevision ||
      run.controlRevision !== input.expectedControlRevision) {
    throw new Error('Changed routine');
  }
  return { state, run };
}

/** Save Stop first. Retry budget and private-thread cleanup separately. */
export async function stopRoutineAfterApproval(store: EventStore, silo: string, raw: unknown) {
  try {
    const input = inputSchema.parse(raw);
    const hash = createHash('sha256');
    const identity = [silo, input.routineId, input.occurrenceId];
    const identityText = JSON.stringify(identity);
    hash.update(identityText);
    const commandId = `routine-approval:${hash.digest('hex')}`;
    const subject = `routine-${input.routineId}`;
    const deadline = performance.now() + 10_000;
    const rows = await history(store, subject, silo, deadline);
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
    const checked = requireRun(state, input, position, silo);
    const run = checked.run;
    const reason = await readRoutineApproval(store, state, input.cause, claimPosition, deadline);
    if (previous) {
      return await checkedReceipt(store, subject, previous, commandId, deadline);
    }
    const stop = { version: 1, routineId: input.routineId,
      occurrenceId: run.occurrenceId, rootId: run.rootId, conversationId: run.conversationId,
      messageId: run.messageId, turnId: run.turnId, definitionRevision: run.definitionRevision,
      scheduleRevision: run.scheduleRevision, controlRevision: run.controlRevision,
      actorId: 'opencrane-server', source: 'approval', reason, cause: input.cause,
      affectedRun: run.occurrenceId, next: checked.state.definition!.next };
    const data = routineStopSchema.parse(stop);
    const event: EventEnvelope = { id: randomUUID(), commandId, subject, silo,
      type: 'routine.run_stop_requested', source: 'opencrane-server',
      principal: { kind: 'system', id: 'opencrane-server' },
      time: new Date().toISOString(), correlation: {}, data };
    const change = { event, expectedSequence: position,
      deadline: performance.now() + 2000, historyChecked: true as const };
    const result = await store.append(change);
    if (result.status === 'conflict') {
      const latest = await history(store, subject, silo, deadline);
      function sameCommand(row: StoredEvent) {
        return row.event.commandId === commandId;
      }
      const saved = latest.find(sameCommand);
      if (saved) {
        return await checkedReceipt(store, subject, saved, commandId, deadline);
      }
    }
    if (result.status !== 'appended') {
      throw new Error('Stop not saved');
    }
    // Read the first saved event after deduplication; another terminal cause may have won.
    const saved = await store.readEvent(result.sequence, deadline);
    return await checkedReceipt(store, subject, saved, commandId, deadline);
  } catch {
    throw new Error('Routine approval Stop refused');
  }
}
