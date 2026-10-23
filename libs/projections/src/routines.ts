import { isDeepStrictEqual } from 'node:util';
import { foldRoutine, parseEventByType, routineRecordIdentitySchema, routineMissedSchema,
  type EventEnvelope,
  type RoutineState } from '@opencrane/events';
import type { Query } from './db.ts';
import type { Projection } from './runner.ts';

type Occurrence = {
  due: NonNullable<RoutineState['activeRun']>;
  activation: RoutineState['activation'];
  terminal: RoutineState['lastRun'];
  stopRequested: boolean;
  terminalReference: { eventId: string; position: number } | null;
};

async function create(db: Query): Promise<void> {
  await db.query(`CREATE TABLE IF NOT EXISTS routines (
    silo TEXT NOT NULL, routine_id TEXT NOT NULL, state JSONB NOT NULL,
    event_id TEXT NOT NULL, position BIGINT NOT NULL, PRIMARY KEY (silo, routine_id))`);
  await db.query(`CREATE TABLE IF NOT EXISTS routine_occurrences (
    silo TEXT NOT NULL, routine_id TEXT NOT NULL, occurrence_id TEXT NOT NULL,
    kind TEXT NOT NULL, data JSONB NOT NULL, event_id TEXT NOT NULL, position BIGINT NOT NULL,
    PRIMARY KEY (silo, routine_id, occurrence_id))`);
}
async function drop(db: Query): Promise<void> {
  await db.query('DROP TABLE IF EXISTS routine_occurrences, routines');
}

async function apply(db: Query, input: EventEnvelope, position: number): Promise<void> {
  if (!input.type.startsWith('routine.')) return;
  const parsed = parseEventByType(input);
  if (!parsed.success) throw new Error('Invalid routine event');
  const event = parsed.event;
  // Read only identity fields here. The event parser checks the full modern or legacy record.
  const identity = routineRecordIdentitySchema.parse(event.data);
  const saved = await db.query<{ state: RoutineState; position: string }>(
    'SELECT state, position FROM routines WHERE silo = $1 AND routine_id = $2',
    [event.silo, identity.routineId]);
  const previous = saved.rows[0];
  if (event.subject !== `routine-${identity.routineId}`) {
    throw new Error('Routine history belongs to another stream');
  }
  if (previous && position <= Number(previous.position)) return;
  const state = previous?.state;
  if (state?.appliedEventIds.includes(event.id)) return;
  const occurrenceId = occurrenceIdentifier(event);
  if (identity.version && occurrenceId) {
    const handled = await applyExistingOccurrence(db, event, state, identity.routineId,
      occurrenceId, position);
    if (handled) return;
  }
  const next = foldRoutine(state, event);
  if (identity.version) await saveNewOccurrence(db, event, next, occurrenceId, position);
  await saveState(db, next, event, position);
}

function occurrenceIdentifier(event: EventEnvelope): string | undefined {
  if (event.type === 'routine.occurrences_missed') {
    const range = routineMissedSchema.parse(event.data);
    return `missed:${range.scheduleRevision}:${range.firstLocalDate}:${range.lastLocalDate}`;
  }
  if (!event.data || typeof event.data !== 'object') return undefined;
  const value: unknown = Reflect.get(event.data, 'occurrenceId');
  if (typeof value === 'string') return value;
  return undefined;
}
async function applyExistingOccurrence(db: Query, event: EventEnvelope,
  state: RoutineState | undefined, routineId: string, occurrenceId: string, position: number) {
  const existing = await db.query<{ kind: string; data: Occurrence }>(
    `SELECT kind, data FROM routine_occurrences
      WHERE silo = $1 AND routine_id = $2 AND occurrence_id = $3`,
    [event.silo, routineId, occurrenceId]);
  const occurrence = existing.rows[0];
  if (!occurrence) return false;
  if (occurrence.kind === 'run' && state) {
    const handled = await updateRun(db, state, occurrence.data, event, position);
    if (handled) return true;
  }
  if (!isDeepStrictEqual(occurrence.data, event.data)) {
    throw new Error('Occurrence identity already belongs to another record');
  }
  return true;
}
async function saveNewOccurrence(db: Query, event: EventEnvelope, state: RoutineState,
  occurrenceId: string | undefined, position: number): Promise<void> {
  if (event.type === 'routine.due' && state.activeRun) {
    const occurrence: Occurrence = { due: state.activeRun, activation: null,
      terminal: null, stopRequested: false, terminalReference: null };
    await insertOccurrence(db, event, state.routineId, state.activeRun.occurrenceId,
      'run', occurrence, position);
  }
  if (event.type === 'routine.occurrence_skipped' || event.type === 'routine.occurrences_missed') {
    let kind = 'skipped';
    if (event.type === 'routine.occurrences_missed') kind = 'missed';
    // Keep each saved range as one record, regardless of its missed-slot count.
    await insertOccurrence(db, event, state.routineId, occurrenceId!, kind, event.data, position);
  }
}

async function updateRun(db: Query, state: RoutineState, saved: Occurrence,
  event: EventEnvelope, position: number): Promise<boolean> {
  if (event.type === 'routine.due') {
    if (!isDeepStrictEqual(saved.due, event.data)) {
      throw new Error('Occurrence binding differs from the saved run');
    }
    return true;
  }
  const runEvents = ['routine.run_activation_admitted', 'routine.run_stop_requested',
    'routine.run_finished'];
  if (!runEvents.includes(event.type)) return false;
  // Check late records against the original run, even after another run has finished.
  const original: RoutineState = { ...state, activeRun: saved.due, lastRun: null,
    activation: saved.activation, stopRequested: saved.stopRequested, appliedEventIds: [] };
  const checked = foldRoutine(original, event);
  if (event.type === 'routine.run_activation_admitted' && saved.activation
      && !isDeepStrictEqual(saved.activation, event.data)) {
    throw new Error('Activation differs from the saved sender attempt');
  }
  if (saved.terminal) return true;
  const next = foldRoutine(state, event);
  let terminalReference = saved.terminalReference;
  if (checked.lastRun) terminalReference = { eventId: event.id, position };
  const occurrence: Occurrence = { due: saved.due,
    activation: checked.activation ?? saved.activation,
    terminal: checked.lastRun, stopRequested: checked.stopRequested, terminalReference };
  await db.query(`UPDATE routine_occurrences SET data = $4
    WHERE silo = $1 AND routine_id = $2 AND occurrence_id = $3`,
  [state.silo, state.routineId, saved.due.occurrenceId, JSON.stringify(occurrence)]);
  await saveState(db, next, event, position);
  return true;
}

async function insertOccurrence(db: Query, event: EventEnvelope, routineId: string,
  occurrenceId: string, kind: string, data: unknown, position: number): Promise<void> {
  await db.query(`INSERT INTO routine_occurrences VALUES ($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT DO NOTHING`,
  [event.silo, routineId, occurrenceId, kind, JSON.stringify(data), event.id, position]);
}
async function saveState(db: Query, state: RoutineState,
  event: EventEnvelope, position: number): Promise<void> {
  await db.query(`INSERT INTO routines VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT (silo, routine_id) DO UPDATE
    SET state = EXCLUDED.state, event_id = EXCLUDED.event_id, position = EXCLUDED.position`,
  [state.silo, state.routineId, JSON.stringify(state), event.id, position]);
}

export const routines: Projection = { name: 'routines', create, drop, apply };
