import { routineDueSchema } from '../../../libs/events/src/routines.ts';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { event } from '@opencrane/event-store/testing';
import type { AppendCommand } from '@opencrane/event-store';
import { foldRoutine, getEventDefinition } from '@opencrane/events';
import { envelope, history, readRootStopEvidence } from '@opencrane/models';
import { routine } from '../../../libs/authz/test/routine-fixture.ts';
import { shortDuplicateWindowFixture, waitForDuplicateWindow }
  from './support/duplicate-window.ts';
import { pauseRoutineAfterDeactivation } from '../src/routine-assistant-pause.ts';

let nats: Awaited<ReturnType<typeof shortDuplicateWindowFixture>>;
let input: { routineId: string; occurrenceId: string; expectedPosition: number;
  expectedDefinitionRevision: number; expectedScheduleRevision: number;
  expectedControlRevision: number; cause: { eventId: string; position: number } };
const due = routineDueSchema.parse(getEventDefinition('routine.due')!.example);
async function settings(active = false, assistantId = 'sales-assistant', silo = 'test') {
  const data = { assistantId, changedBy: 'admin', changedFields: ['active'], active };
  const saved = envelope(silo, `assistant-${assistantId}`, 'assistant.settings_changed', data);
  await nats.seed([saved]);
  return { eventId: saved.id, position: await nats.store.head(saved.subject) };
}
async function setup() {
  nats = await shortDuplicateWindowFixture();
  const created = routine('routine.created');
  const saved = { ...created, data: { ...getEventDefinition('routine.created')!.example,
    status: 'active' } };
  const claimed = { ...event('due', 'routine-orders', 'routine.due'), data: due,
    source: 'opencrane-server', principal: { kind: 'system' as const, id: 'opencrane-server' } };
  await nats.seed([saved, claimed]);
  input = { routineId: 'orders', occurrenceId: 'occurrence',
    expectedPosition: await nats.store.head('routine-orders'), expectedDefinitionRevision: 1,
    expectedScheduleRevision: 1, expectedControlRevision: 1, cause: await settings() };
}
async function cleanup() {
  vi.restoreAllMocks();
  await nats?.close();
}
beforeEach(setup);
afterEach(cleanup);
function pause(request: unknown = input) {
  return pauseRoutineAfterDeactivation(nats.store, 'test', request);
}
async function savesOnce() {
  const before = await nats.store.head();
  const [first, concurrent] = await Promise.all([pause(), pause()]);
  expect(concurrent).toEqual(first);
  expect(await pause()).toEqual(first);
  expect(await nats.store.head()).toBe(before + 1);
  const proof = await readRootStopEvidence(nats.store, 'routine-orders', first.position);
  expect(proof.event.data).toMatchObject({ source: 'access', reason: 'assistant_inactive',
    actorId: 'opencrane-server', affectedRun: 'occurrence', cause: input.cause });
  expect(proof.routine?.activeRun).toEqual(due);
  expect(proof.routine?.definition?.definition).toEqual(due.definition);
  expect(proof.routine?.definition?.next).toEqual(due.slot);
}
it('saves one exact assistant pause and preserves the occupied run and schedule', savesOnce);
