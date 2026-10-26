import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { foldRoutine, getEventDefinition, type RoutineState } from '@opencrane/events';
import type { EventEnvelope } from '@opencrane/events';
import type { StoredEvent } from '@opencrane/event-store';
import { shortDuplicateWindowFixture } from '../../server/test/support/duplicate-window.ts';
import { claimRoutineDue } from '../src/routine-due.ts';

let nats: Awaited<ReturnType<typeof shortDuplicateWindowFixture>>;
let now: number;
let owned: boolean;
const input = { routineId: 'orders', expectedPosition: 1, localDate: '2026-10-25',
  definitionRevision: 1, scheduleRevision: 1, controlRevision: 1 };
function clock() {
  return now;
}
async function checkCurrent() {
  return owned;
}
const worker = { silo: 'test', checkCurrent, now: clock };
function creation(): EventEnvelope {
  const example = getEventDefinition('routine.created')!.example as
    NonNullable<RoutineState['definition']>;
  const schedule = { frequency: 'weekly' as const, weekday: 7,
    localTime: '02:30', zone: 'Europe/Brussels' };
  const definition = { ...example.definition, schedule };
  const next = { localDate: input.localDate, localTime: '02:30', zone: 'Europe/Brussels',
    at: '2026-10-25T00:30:00.000Z', offsetMinutes: 120 };
  const data = { ...example, status: 'active', definition, next };
  return { id: 'created', commandId: 'created', silo: 'test', source: 'opencrane-server',
    type: 'routine.created', subject: 'routine-orders', time: example.effectiveAt,
    principal: { kind: 'human', id: 'alice' }, correlation: {}, data };
}
async function setup() {
  nats = await shortDuplicateWindowFixture();
  now = Date.parse('2026-10-25T00:30:00.000Z');
  owned = true;
  await nats.seed([creation()]);
}
async function cleanup() {
  vi.restoreAllMocks();
  await nats?.close();
}
beforeEach(setup);
afterEach(cleanup);
function claim(request = input) {
  return claimRoutineDue(nats.store, worker, request);
}
async function rows() {
  const result: StoredEvent[] = [];
  for await (const row of nats.store.readStream('routine-orders')) {
    result.push(row);
  }
  return result;
}
async function savesOneOccurrence() {
  const [first, second] = await Promise.all([claim(), claim()]);
  expect(second).toEqual(first);
  expect(first).toMatchObject({ status: 'confirmed', position: 2,
    firedAt: '2026-10-25T00:30:00.000Z', startBy: '2026-10-25T00:31:00.000Z',
    executionAvailable: false });
  expect(new Set([first.occurrenceId, first.conversationId, first.messageId,
    first.turnId, first.rootId]).size).toBe(5);
  const saved = await rows();
  expect(saved).toHaveLength(2);
  let state: RoutineState | undefined;
  for (const row of saved) {
    state = foldRoutine(state, row.event);
  }
  expect(state?.executionAvailable).toBe(false);
  expect(state?.activeRun?.definition).toEqual(state?.definition?.definition);
  expect(state?.activeRun?.slot.at).toBe('2026-10-25T00:30:00.000Z');
  expect(await nats.store.head()).toBe(2);
  expect(JSON.stringify(first)).not.toMatch(/ciphertext|instructions|key:1/u);
}
it('claims the first repeated-hour instant once without starting any work', savesOneOccurrence);
