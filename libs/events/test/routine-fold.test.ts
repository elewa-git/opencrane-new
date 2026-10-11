import { expect, it } from 'vitest';
import { foldRoutine, getEventDefinition, type EventEnvelope } from '../src/index.ts';

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

function pureReplayKeepsSavedFacts() {
  const example = getEventDefinition('routine.created')?.example;
  const created = record('routine.created', example);
  created.principal = { kind: 'human', id: 'alice' };
  const initial = structuredClone(created);
  const state = foldRoutine(undefined, created);
  const before = structuredClone(state);
  const finished = getEventDefinition('routine.run_finished')?.example;
  const terminal = record('routine.run_finished', finished);
  const result = foldRoutine(state, terminal);
  expect(created).toEqual(initial);
  expect(state).toEqual(before);
  expect(foldRoutine(foldRoutine(undefined, created), terminal)).toEqual(result);
  expect(result?.executionAvailable).toBe(false);
  const forged = { ...created, subject: 'routine-other' };
  expect(() => foldRoutine(state, forged)).toThrow();
}
it('folds recorded facts without changing inputs and rebuilds equal state', pureReplayKeepsSavedFacts);
