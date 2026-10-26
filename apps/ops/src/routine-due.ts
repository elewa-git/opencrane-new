import { isDeepStrictEqual } from 'node:util';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
import { foldRoutine, routineRecordIdentitySchema, type EventEnvelope,
  type RoutineState } from '@opencrane/events';
import { calculateRoutineOccurrence } from '@opencrane/events/routine-schedule';

type Run = NonNullable<RoutineState['activeRun']>;
interface Input {
  routineId: string;
  expectedPosition: number;
  localDate: string;
  definitionRevision: number;
  scheduleRevision: number;
  controlRevision: number;
}
interface Worker {
  silo: string;
  // Supply this from the trusted worker, never from a request or saved due record.
  checkCurrent: (deadline: number) => Promise<boolean>;
  now?: () => number;
}
class DueRefused extends Error {
  constructor() {
    super('Routine due refused');
  }
}
function requireInput(input: Input) {
  const names = ['routineId', 'expectedPosition', 'localDate', 'definitionRevision',
    'scheduleRevision', 'controlRevision'];
  for (const name of Object.keys(input)) {
    if (!names.includes(name)) {
      throw new DueRefused();
    }
  }
  const revisions = [input.expectedPosition, input.definitionRevision,
    input.scheduleRevision, input.controlRevision];
  for (const revision of revisions) {
    if (!Number.isSafeInteger(revision) || revision < 1) {
      throw new DueRefused();
    }
  }
  if (typeof input.routineId !== 'string' || !/^[\w-]{1,200}$/u.test(input.routineId) ||
      typeof input.localDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(input.localDate)) {
    throw new DueRefused();
  }
}
async function loadHistory(store: EventStore, silo: string, input: Input) {
  const rows: StoredEvent[] = [];
  let state: RoutineState | undefined;
  const deadline = performance.now() + 10_000;
  for await (const row of store.readStream(`routine-${input.routineId}`, 1, deadline)) {
    const identity = routineRecordIdentitySchema.parse(row.event.data);
    if (row.event.silo !== silo || identity.version !== 1 ||
        (rows.length === 0 && row.event.type !== 'routine.created')) {
      throw new DueRefused();
    }
    state = foldRoutine(state, row.event);
    rows.push(row);
  }
  if (performance.now() >= deadline) {
    throw new DueRefused();
  }
  return { rows, state };
}
function dueData(state: RoutineState | undefined, input: Input, firedAt: string): Run {
  const saved = state?.definition;
  const slot = saved?.next;
  if (!saved || !slot || state.status !== 'active' || state.activeRun ||
      saved.definitionRevision !== input.definitionRevision ||
      saved.scheduleRevision !== input.scheduleRevision ||
      saved.controlRevision !== input.controlRevision || slot.localDate !== input.localDate ||
      Date.parse(slot.at) <= Date.parse(saved.effectiveAt) ||
      (saved.cursor && saved.cursor.localDate >= slot.localDate)) {
    throw new DueRefused();
  }
  const calculation = { silo: state.silo, routineId: input.routineId,
    scheduleRevision: saved.scheduleRevision, schedule: saved.definition.schedule,
    localDate: slot.localDate };
  const occurrence = calculateRoutineOccurrence(calculation);
  const occurrenceId = occurrence.occurrenceId;
  const startBy = new Date(Date.parse(firedAt) + 60_000).toISOString();
  return { version: 1, routineId: input.routineId,
    definitionRevision: saved.definitionRevision, scheduleRevision: saved.scheduleRevision,
    controlRevision: saved.controlRevision, occurrenceId,
    conversationId: `routine-session-${occurrenceId}`, messageId: `routine-input-${occurrenceId}`,
    turnId: `routine-turn-${occurrenceId}`, rootId: `routine-root-${occurrenceId}`,
    source: 'scheduled', definition: saved.definition, slot, firedAt, startBy };
}
function requireSlot(silo: string, run: Run, now: number) {
  const calculation = { silo, routineId: run.routineId, scheduleRevision: run.scheduleRevision,
    schedule: run.definition.schedule, localDate: run.slot.localDate };
  const occurrence = calculateRoutineOccurrence(calculation);
  const lateness = now - Date.parse(run.slot.at);
  if (occurrence.status !== 'scheduled' || occurrence.at !== new Date(run.slot.at).toISOString() ||
      occurrence.offsetMinutes !== run.slot.offsetMinutes ||
      occurrence.localTime !== run.slot.localTime || occurrence.zone !== run.slot.zone ||
      !Number.isFinite(lateness) || lateness < 0 || lateness > 60_000) {
    throw new DueRefused();
  }
}
function envelope(silo: string, data: Run): EventEnvelope {
  const id = `routine-due-${data.occurrenceId}`;
  return { id, commandId: id, silo, source: 'opencrane-server', type: 'routine.due',
    subject: `routine-${data.routineId}`, time: data.firedAt,
    principal: { kind: 'system', id: 'opencrane-server' }, correlation: {}, data };
}
function receipt(row: StoredEvent, run: Run) {
  return { status: 'confirmed' as const, eventId: row.event.id, position: row.sequence,
    occurrenceId: run.occurrenceId, conversationId: run.conversationId,
    messageId: run.messageId, turnId: run.turnId, rootId: run.rootId,
    firedAt: run.firedAt, startBy: run.startBy, executionAvailable: false as const };
}
function savedReceipt(row: StoredEvent, state: RoutineState | undefined, input: Input) {
  const folded = foldRoutine(state, row.event);
  const run = folded.activeRun;
  if (!run) {
    throw new DueRefused();
  }
  const expected = dueData(state, input, run.firedAt);
  // Compare the full frozen record, including ids and expiry, before returning a retry.
  if (!isDeepStrictEqual(row.event, envelope(row.event.silo, expected))) {
    throw new DueRefused();
  }
  const lateness = Date.parse(run.firedAt) - Date.parse(run.slot.at);
  if (lateness < 0 || lateness > 60_000) {
    throw new DueRefused();
  }
  return receipt(row, run);
}
function previousReceipt(rows: StoredEvent[], input: Input) {
  let state: RoutineState | undefined;
  let position = 0;
  for (const row of rows) {
    if (position === input.expectedPosition && row.event.type === 'routine.due') {
      return savedReceipt(row, state, input);
    }
    state = foldRoutine(state, row.event);
    position = row.sequence;
  }
  return undefined;
}

/** Claim one saved slot. A confirmed record never grants permission to start work. */
export async function claimRoutineDue(store: EventStore, worker: Worker, input: Input) {
  try {
    requireInput(input);
    const saved = await loadHistory(store, worker.silo, input);
    const previous = previousReceipt(saved.rows, input);
    if (previous) {
      return previous;
    }
    if (saved.rows.at(-1)?.sequence !== input.expectedPosition) {
      throw new DueRefused();
    }
    const now = worker.now ?? Date.now;
    const run = dueData(saved.state, input, new Date(now()).toISOString());
    requireSlot(worker.silo, run, now());
    const event = envelope(worker.silo, run);
    for (const row of saved.rows) {
      // Keep a consumed slot closed even after later controls or completed runs.
      const data = row.event.data;
      if (row.event.type === 'routine.due' && typeof data === 'object' && data !== null &&
          Reflect.get(data, 'occurrenceId') === run.occurrenceId) {
        throw new DueRefused();
      }
    }
    foldRoutine(saved.state, event);
    // Retain the checked history before starting the short ownership check.
    const deadline = performance.now() + 2000;
    async function checkAccess() {
      if (!(await worker.checkCurrent(deadline)) || performance.now() >= deadline) {
        throw new DueRefused();
      }
      requireSlot(worker.silo, run, now());
    }
    const change = { event, expectedSequence: input.expectedPosition,
      historyChecked: true as const, deadline, checkAccess };
    const result = await store.append(change);
    if (result.status === 'conflict' || result.status === 'rejected') {
      throw new DueRefused();
    }
    if (result.status !== 'appended') {
      throw new Error('Append unavailable');
    }
    const row = await store.readEvent(result.sequence, performance.now() + 10_000);
    return savedReceipt(row, saved.state, input);
  } catch (error) {
    if (error instanceof DueRefused) {
      throw error;
    }
    // eslint-disable-next-line preserve-caught-error -- Do not expose private service details.
    throw new Error('Routine due unavailable');
  }
}
