import { isDeepStrictEqual } from 'node:util';
import { foldRoutineHistory } from '@opencrane/authz';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
import { routineActivationSchema, routineStopSchema, type RoutineState } from '@opencrane/events';
import { history, readRootStopEvidence } from '@opencrane/models';

type Admission = { routineId: string; eventId: string; position: number };

// Record uncertainty without releasing the occupied run or claiming native termination.
export async function stopUnconfirmedRoutine(store: EventStore, silo: string,
  admission: Admission) {
  const subject = `routine-${admission.routineId}`;
  const deadline = performance.now() + 10_000;
  const rows = await history(store, subject, silo, deadline);
  let state: RoutineState | undefined;
  let activation: ReturnType<typeof routineActivationSchema.parse> | undefined;
  const completed = new Map<string, NonNullable<RoutineState['activeRun']>>();
  for (const row of rows) {
    if (row.sequence === admission.position && row.event.id === admission.eventId &&
        row.event.type === 'routine.run_activation_admitted') {
      activation = routineActivationSchema.parse(row.event.data);
    }
    if (activation && matchesDeliveryStop(row, admission)) {
      await readRootStopEvidence(store, subject, row.sequence, deadline);
      return;
    }
    state = foldRoutineHistory(state, row.event, completed);
  }
  if (!activation || !state?.activeRun || !isDeepStrictEqual(state.activation, activation)) {
    throw new Error('Routine delivery Stop unavailable');
  }
  const { senderAttemptId: _attempt, admission: _allocation, ...run } = activation;
  const cause = { eventId: admission.eventId, position: admission.position };
  const stop = { ...run, actorId: 'opencrane-server', source: 'delivery',
    reason: 'start_unconfirmed', affectedRun: run.occurrenceId,
    next: state.definition!.next, cause };
  const data = routineStopSchema.parse(stop);
  const id = `routine-delivery-${run.occurrenceId}`;
  const event = { id, commandId: id, subject, silo, data,
    type: 'routine.run_stop_requested', source: 'opencrane-server',
    principal: { kind: 'system' as const, id: 'opencrane-server' },
    time: new Date().toISOString(), correlation: {} };
  // Save only a prohibition. Lost leadership must not prevent cancelling its own attempt.
  const appendDeadline = Math.min(deadline, performance.now() + 2000);
  const change = { event, expectedSequence: rows.at(-1)!.sequence,
    deadline: appendDeadline, historyChecked: true as const };
  const result = await store.append(change);
  if (result.status !== 'appended') {
    throw new Error('Routine delivery Stop unavailable');
  }
}

function matchesDeliveryStop(row: StoredEvent, admission: Admission) {
  if (row.event.type !== 'routine.run_stop_requested') {
    return false;
  }
  const stop = routineStopSchema.parse(row.event.data);
  return stop.source === 'delivery' && stop.cause?.eventId === admission.eventId
    && stop.cause.position === admission.position;
}
