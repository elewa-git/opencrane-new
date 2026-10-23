import { expect, it } from 'vitest';
import { foldRoutine, getEventDefinition, routineDefinitionSchema, type EventEnvelope } from '../src/index.ts';

function record(type: string, data: unknown): EventEnvelope {
  return { id: type, commandId: type, type, data, silo: 'test',
    subject: 'routine-orders', source: 'opencrane-server', time: '2026-10-11T07:00:00Z',
    principal: { kind: 'system', id: 'opencrane-server' }, correlation: {} };
}
function legacyReplayHasNoAuthority() {
  const created = record('routine.created', { routineId: 'orders', assistantId: 'old',
    schedule: '0 9 * * *', createdBy: 'alice' });
  const due = record('routine.due', { routineId: 'orders', firedAt: created.time });
  const resumed = record('routine.resumed', { routineId: 'orders', resumedBy: 'alice' });
  const state = foldRoutine(undefined, created);
  const replayed = foldRoutine(foldRoutine(state, due), resumed);
  expect(replayed).toMatchObject({ status: 'legacy-needs-migration', definition: null,
    activeRun: null, executionAvailable: false });
  expect(replayed).toEqual(state);
}
it('keeps legacy replay without owner authority or firing eligibility', legacyReplayHasNoAuthority);

function example(type: string): Record<string, unknown> {
  const data: unknown = getEventDefinition(type)?.example;
  if (typeof data !== 'object' || data === null) throw new Error('Missing routine example');
  return { ...data };
}
function saved(type: string): EventEnvelope {
  const event = record(type, example(type));
  if (type === 'routine.created' || type === 'routine.resumed' || type === 'routine.updated' ||
      type === 'routine.paused' || type === 'routine.retired') {
    event.principal = { kind: 'human', id: 'alice' };
  }
  return event;
}
function pureReplayKeepsSavedFacts() {
  const created = saved('routine.created');
  const resumed = saved('routine.resumed');
  const due = saved('routine.due');
  const terminal = saved('routine.run_finished');
  const initial = structuredClone(created);
  const state = foldRoutine(foldRoutine(foldRoutine(undefined, created), resumed), due);
  const admitted = foldRoutine(state, saved('routine.run_activation_admitted'));
  const stopped = record('routine.run_stop_requested', example('routine.run_stop_requested'));
  stopped.principal = { kind: 'human', id: 'alice' };
  expect(foldRoutine(admitted, stopped)).toMatchObject({ stopRequested: true,
    activeRun: { occurrenceId: 'occurrence' }, executionAvailable: false });
  const forged = record('routine.run_finished', { ...example('routine.run_finished'),
    definitionRevision: 2 });
  expect(() => foldRoutine(state, forged)).toThrow('saved active run');
  const before = structuredClone(state);
  const result = foldRoutine(state, terminal);
  expect(created).toEqual(initial);
  expect(state).toEqual(before);
  let replayed;
  for (const event of [created, resumed, due, terminal]) {
    replayed = foldRoutine(replayed, event);
  }
  expect(replayed).toEqual(result);
  expect(result).toMatchObject({ status: 'active', activeRun: null,
    lastRun: { outcome: 'cancelled' }, executionAvailable: false });
  const lateSuccess = record('routine.run_finished', { ...example('routine.run_finished'),
    outcome: 'succeeded' });
  expect(foldRoutine(result, lateSuccess)).toEqual(result);
  expect(foldRoutine(result, due)).toEqual(result);
  expect(() => foldRoutine(state, { ...created, subject: 'routine-other' })).toThrow();
  expect(() => foldRoutine(state, { ...created, silo: 'foreign' })).toThrow();
}
it('folds pure facts, rebuilds equal state and keeps the first terminal result',
  pureReplayKeepsSavedFacts);

function refusesForgedRunAndActiveMigration() {
  const created = saved('routine.created');
  const state = foldRoutine(foldRoutine(undefined, created), saved('routine.resumed'));
  const due = example('routine.due');
  const definition = routineDefinitionSchema.parse(due['definition']);
  const forged = record('routine.due', { ...due, definition: { ...definition, profileId: 'other' } });
  expect(() => foldRoutine(state, forged)).toThrow('active saved definition');
  const replacement = example('routine.updated');
  const foreignOwner = { ...definition, ownerId: 'bob' };
  const edit = record('routine.updated', { ...replacement, actorId: 'bob', definition: foreignOwner });
  edit.principal = { kind: 'human', id: 'bob' };
  expect(() => foldRoutine(state, edit)).toThrow('reassignment');
  const legacy = record('routine.created', { routineId: 'orders', assistantId: 'old',
    schedule: '0 9 * * *', createdBy: 'alice' });
  const oldState = foldRoutine(undefined, legacy);
  const updated = saved('routine.updated');
  const active = { ...updated, data: { ...example('routine.updated'), status: 'active' } };
  expect(() => foldRoutine(oldState, active)).toThrow();
  expect(foldRoutine(oldState, updated)).toMatchObject({ status: 'paused',
    activeRun: null, executionAvailable: false });
}
it('refuses foreign frozen definitions and requires paused legacy modernisation',
  refusesForgedRunAndActiveMigration);

function duplicateCreateKeepsResumedState() {
  const created = saved('routine.created');
  const resumed = saved('routine.resumed');
  const initial = foldRoutine(undefined, created);
  const active = foldRoutine(initial, resumed);
  const before = structuredClone(active);
  const originalCreate = structuredClone(created);

  expect(active.status).toBe('active');
  expect(foldRoutine(active, created)).toEqual(active);
  expect(active).toEqual(before);
  expect(created).toEqual(originalCreate);
}
it('ignores a duplicate create delivered after resume', duplicateCreateKeepsResumedState);

function duplicateResumeKeepsPausedState() {
  const created = saved('routine.created');
  const resumed = saved('routine.resumed');
  const paused = saved('routine.paused');
  paused.data = { ...example('routine.paused'), controlRevision: 2, next: null };
  const initial = foldRoutine(undefined, created);
  const active = foldRoutine(initial, resumed);
  const stopped = foldRoutine(active, paused);
  const before = structuredClone(stopped);

  expect(stopped.status).toBe('paused');
  expect(foldRoutine(stopped, resumed)).toEqual(stopped);
  expect(stopped).toEqual(before);

  const laterResume = saved('routine.resumed');
  laterResume.id = 'later-resume';
  laterResume.commandId = 'later-resume';
  laterResume.data = { ...example('routine.resumed'), controlRevision: 3 };
  const reactivated = foldRoutine(stopped, laterResume);
  expect(reactivated).toMatchObject({ status: 'active',
    definition: { controlRevision: 3 }, executionAvailable: false });
}
it('ignores an earlier duplicate resume delivered after pause', duplicateResumeKeepsPausedState);

function duplicateHistoryKeepsRetiredState() {
  const history = [saved('routine.created'), saved('routine.resumed'), saved('routine.due'),
    saved('routine.run_finished'), saved('routine.paused'), saved('routine.retired')];
  let state;
  for (const event of history) {
    state = foldRoutine(state, event);
  }
  const retired = structuredClone(state);

  expect(state).toMatchObject({ status: 'retired', activeRun: null,
    lastRun: { outcome: 'cancelled' }, executionAvailable: false });
  for (const event of history) {
    state = foldRoutine(state, event);
    expect(state).toEqual(retired);
  }
}
it('ignores duplicate history delivered after retirement', duplicateHistoryKeepsRetiredState);

function savedDefinitionSurvivesDatabaseOrdering() {
  const initial = foldRoutine(undefined, saved('routine.created'));
  const active = foldRoutine(initial, saved('routine.resumed'));
  if (!active.definition) throw new Error('Missing saved definition');
  const { name, ...remaining } = active.definition.definition;
  const reordered = { ...remaining, name };
  const definition = { ...active.definition, definition: reordered };
  const restored = { ...active, definition };
  const due = saved('routine.due');
  const result = foldRoutine(restored, due);
  expect(result.activeRun).toEqual(due.data);
}
it('accepts a saved definition whose object fields changed order in storage',
  savedDefinitionSurvivesDatabaseOrdering);
