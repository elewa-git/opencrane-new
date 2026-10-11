import type { z } from 'zod';
import type { EventEnvelope } from './envelope.ts';
import { parseEventByType } from './parse.ts';
import * as schemas from './routines.ts';

type DefinitionRecord = z.infer<typeof schemas.routineDefinitionEventSchema>;
type RunRecord = z.infer<typeof schemas.routineDueSchema>;
type FinishedRecord = z.infer<typeof schemas.routineFinishedSchema>;
export interface RoutineState {
  readonly silo: string;
  readonly routineId: string;
  readonly status: 'active' | 'paused' | 'retired' | 'legacy-needs-migration';
  readonly definition: DefinitionRecord | null;
  readonly activeRun: RunRecord | null;
  readonly lastRun: FinishedRecord | null;
  readonly activation: z.infer<typeof schemas.routineActivationSchema> | null;
  readonly stopRequested: boolean;
  readonly appliedEventIds: readonly string[];
  // Keep saved facts separate from admission: no routine record grants execution permission.
  readonly executionAvailable: false;
}
function saveDefinition(state: RoutineState, event: EventEnvelope, hasHistory: boolean) {
  const definition = schemas.routineDefinitionEventSchema.parse(event.data);
  if (state.status === 'retired' ||
      (state.status === 'legacy-needs-migration' && hasHistory &&
        (event.type !== 'routine.updated' || definition.status !== 'paused'))) {
    throw new Error('A retired or legacy routine cannot become active through an edit');
  }
  if (state.definition &&
      state.definition.definition.ownerId !== definition.definition.ownerId) {
    throw new Error('Changing the owner requires reassignment');
  }
  return { ...state, definition, status: definition.status };
}
function saveRun(state: RoutineState, event: EventEnvelope): RoutineState {
  const run = schemas.routineDueSchema.parse(event.data);
  if (state.lastRun?.occurrenceId === run.occurrenceId) {
    return state;
  }
  const saved = state.definition;
  if (!saved || state.status !== 'active' || run.definitionRevision !== saved.definitionRevision ||
      run.scheduleRevision !== saved.scheduleRevision ||
      run.controlRevision !== saved.controlRevision ||
      JSON.stringify(run.definition) !== JSON.stringify(saved.definition)) {
    throw new Error('A run must use the active saved definition');
  }
  if (state.activeRun) {
    if (JSON.stringify(state.activeRun) === JSON.stringify(run)) {
      return state;
    }
    throw new Error('A routine already has an active run');
  }
  return { ...state, activeRun: run, activation: null, stopRequested: false };
}
function finishRun(state: RoutineState, event: EventEnvelope): RoutineState {
  const finished = schemas.routineFinishedSchema.parse(event.data);
  if (state.lastRun?.occurrenceId === finished.occurrenceId) {
    return state;
  }
  requireActiveRun(state, finished);
  return { ...state, activeRun: null, activation: null, lastRun: finished };
}
function saveControl(state: RoutineState, event: EventEnvelope): RoutineState {
  if (!state.definition || state.status === 'retired') {
    return state;
  }
  const control = schemas.routineControlSchema.parse(event.data);
  let status: RoutineState['status'] = 'paused';
  if (event.type === 'routine.resumed') {
    status = 'active';
  }
  if (event.type === 'routine.retired') {
    status = 'retired';
  }
  const definition = { ...state.definition, controlRevision: control.controlRevision,
    next: control.next };
  return { ...state, status, definition };
}
function requireActiveRun(state: RoutineState, binding: {
  occurrenceId: string; rootId: string; conversationId: string; messageId: string; turnId: string;
  definitionRevision: number; scheduleRevision: number; controlRevision: number;
}) {
  const run = state.activeRun;
  if (!run || run.occurrenceId !== binding.occurrenceId || run.rootId !== binding.rootId ||
      run.conversationId !== binding.conversationId || run.messageId !== binding.messageId ||
      run.turnId !== binding.turnId || run.definitionRevision !== binding.definitionRevision ||
      run.scheduleRevision !== binding.scheduleRevision ||
      run.controlRevision !== binding.controlRevision) {
    throw new Error('Record must name the saved active run');
  }
}
function saveOtherFact(state: RoutineState, event: EventEnvelope): RoutineState {
  if (event.type === 'routine.run_activation_admitted') {
    const activation = schemas.routineActivationSchema.parse(event.data);
    requireActiveRun(state, activation);
    return { ...state, activation };
  }
  if (event.type === 'routine.run_stop_requested') {
    const stop = schemas.routineStopSchema.parse(event.data);
    requireActiveRun(state, stop);
    return { ...state, stopRequested: true };
  }
  if (!state.definition || state.status === 'retired') {
    return state;
  }
  if (event.type === 'routine.reassigned') {
    const reassigned = schemas.routineReassignedSchema.parse(event.data);
    const definition = { ...state.definition, definition: reassigned.definition,
      definitionRevision: reassigned.definitionRevision,
      scheduleRevision: reassigned.scheduleRevision, controlRevision: reassigned.controlRevision,
      next: reassigned.next, status: 'paused' as const };
    return { ...state, definition, status: 'paused' };
  }
  const progress = schemas.routineSkippedSchema.or(schemas.routineMissedSchema).parse(event.data);
  const definition = { ...state.definition, cursor: progress.cursor, next: progress.next };
  return { ...state, definition };
}
function requireRoutineStream(previous: RoutineState | undefined,
  event: EventEnvelope, routineId: string) {
  if (event.subject !== `routine-${routineId}` ||
      (previous && (previous.silo !== event.silo || previous.routineId !== routineId))) {
    throw new Error('Routine history belongs to another stream');
  }
}
function applyModernEvent(state: RoutineState, event: EventEnvelope,
  hasHistory: boolean): RoutineState {
  switch (event.type) {
    case 'routine.created':
    case 'routine.updated':
      return saveDefinition(state, event, hasHistory);
    case 'routine.paused':
    case 'routine.resumed':
    case 'routine.retired':
      return saveControl(state, event);
    case 'routine.due':
      return saveRun(state, event);
    case 'routine.run_finished':
      return finishRun(state, event);
    default:
      return saveOtherFact(state, event);
  }
}
/** Rebuild routine facts without I/O, clock reads, permissions or execution. */
export function foldRoutine(previous: RoutineState | undefined,
  input: EventEnvelope): RoutineState {
  const checked = parseEventByType(input);
  if (!checked.success || !input.type.startsWith('routine.')) {
    throw new Error('Invalid routine event');
  }
  const event = checked.event;
  const data = schemas.routineRecordIdentitySchema.parse(event.data);
  requireRoutineStream(previous, event, data.routineId);
  const state: RoutineState = previous ?? { silo: event.silo, routineId: data.routineId,
    status: 'legacy-needs-migration', definition: null, activeRun: null, lastRun: null,
    activation: null, stopRequested: false, appliedEventIds: [], executionAvailable: false };
  if (!data.version) {
    return state;
  }
  // Keep every modern event id so an older delivery cannot replace newer saved facts.
  if (state.appliedEventIds.includes(event.id)) {
    return state;
  }
  const appliedEventIds = [...state.appliedEventIds, event.id];
  const stateWithEvent = { ...state, appliedEventIds };
  return applyModernEvent(stateWithEvent, event, previous !== undefined);
}
