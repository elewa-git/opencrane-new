import { z } from 'zod';
import { routineDueSchema } from '../../../libs/events/src/routines.ts';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { event } from '@opencrane/event-store/testing';
import type { AppendCommand } from '@opencrane/event-store';
import { foldRoutine, getEventDefinition } from '@opencrane/events';
import { BudgetActor, envelope, history, readRootStopEvidence } from '@opencrane/models';
import { routine } from '../../../libs/authz/test/routine-fixture.ts';
import { shortDuplicateWindowFixture, waitForDuplicateWindow }
  from './support/duplicate-window.ts';
import { pauseRoutineAfterDeactivation } from '../src/routine-assistant-pause.ts';

let nats: Awaited<ReturnType<typeof shortDuplicateWindowFixture>>;
let earlier: { eventId: string; position: number };
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
function example(type: string) {
  return z.record(z.string(), z.unknown()).parse(getEventDefinition(type)!.example);
}
async function setup() {
  nats = await shortDuplicateWindowFixture();
  earlier = await settings();
  const created = routine('routine.created');
  const saved = { ...created, data: { ...example('routine.created'),
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

async function refusesChangedInput(field: string) {
  let value: unknown = 2;
  if (field === 'occurrenceId') value = 'another';
  if (field === 'routineId') value = 'another';
  if (field === 'expectedPosition') value = 0;
  if (field === 'cause') value = { ...input.cause, eventId: 'private-forged-cause' };
  const before = await nats.store.head();
  await expect(pause({ ...input, [field]: value }))
    .rejects.toThrow(/^Routine assistant pause refused$/u);
  expect(await nats.store.head()).toBe(before);
}
it.each(['routineId', 'occurrenceId', 'expectedPosition', 'expectedDefinitionRevision',
  'expectedScheduleRevision', 'expectedControlRevision', 'cause'])(
  'refuses changed %s without appending', refusesChangedInput);

async function invalidCause(kind: string) {
  if (kind === 'assistant') input.cause = await settings(false, 'another');
  if (kind === 'silo') input.cause = await settings(false, 'sales-assistant', 'foreign');
  if (kind === 'active') input.cause = await settings(true);
  if (kind === 'missing') input.cause.position += 100;
  if (kind === 'before due') input.cause = earlier;
  if (kind === 'admission') await admit();
  const before = await nats.store.head();
  await expect(pause()).rejects.toThrow(/^Routine assistant pause refused$/u);
  expect(await nats.store.head()).toBe(before);
}
it.each(['assistant', 'silo', 'active', 'missing', 'before due', 'admission'])(
  'refuses an invalid saved cause: %s', invalidCause);

async function recovery() {
  const append = nats.store.append.bind(nats.store);
  async function loseReply(change: AppendCommand): Promise<never> {
    await append(change);
    throw new Error('private-service-canary');
  }
  vi.spyOn(nats.store, 'append').mockImplementationOnce(loseReply);
  await expect(pause()).rejects.toThrow(/^Routine assistant pause refused$/u);
  const original = await nats.store.readEvent(await nats.store.head('routine-orders'));
  await settings(true);
  await waitForDuplicateWindow(nats);
  await nats.stop();
  await nats.restart();
  const before = await nats.store.head();
  const [first, concurrent] = await Promise.all([pause(), pause()]);
  expect(concurrent).toEqual(first);
  expect(first).toEqual({ status: 'confirmed', eventId: original.event.id,
    position: original.sequence });
  expect(await nats.store.head()).toBe(before);
  const rows = await history(nats.store, 'routine-orders', 'test');
  let state;
  for (const row of rows) state = foldRoutine(state, row.event);
  expect(state).toMatchObject({ status: 'paused', executionAvailable: false });
  expect(state?.activeRun).toEqual(due);
  const proof = await readRootStopEvidence(nats.store, 'routine-orders', first.position);
  expect(proof.routine?.activeRun).toEqual(due);
}
it('recovers a lost reply after deduplication expiry, restart and reactivation', recovery);

async function writeWindow(kind: string) {
  const read = nats.store.readStream.bind(nats.store);
  const append = nats.store.append.bind(nats.store);
  const now = performance.now.bind(performance);
  let elapsed = 0;
  let writing = false;
  function clock() {
    return now() + elapsed;
  }
  async function* historyFirst(subject: string, from?: number, deadline?: number) {
    expect(writing).toBe(false);
    yield* read(subject, from, deadline);
    if (subject === 'routine-orders') elapsed += 3000;
  }
  async function publish(change: AppendCommand) {
    writing = true;
    expect(change.deadline! - clock()).toBeLessThanOrEqual(2000);
    if (kind === 'expired') elapsed += 2001;
    if (kind === 'changed assistant') await settings(true);
    if (kind === 'unrelated assistant') await settings(false, 'another');
    return append(change);
  }
  vi.spyOn(performance, 'now').mockImplementation(clock);
  vi.spyOn(nats.store, 'readStream').mockImplementation(historyFirst);
  vi.spyOn(nats.store, 'append').mockImplementationOnce(publish);
  if (kind === 'slow history' || kind === 'unrelated assistant') {
    await expect(pause()).resolves.toMatchObject({ status: 'confirmed' });
  } else {
    await expect(pause()).rejects.toThrow(/^Routine assistant pause refused$/u);
    expect(await nats.store.head('routine-orders')).toBe(input.expectedPosition);
  }
}
it.each(['slow history', 'expired', 'changed assistant', 'unrelated assistant'])(
  'keeps history outside the original two-second write check: %s', writeWindow);

async function admit() {
  const actor = new BudgetActor(nats.store, 'test');
  await actor.start(10_000, 10_000, 'sales');
  const binding = { requesterId: 'alice', assistantId: 'sales-assistant', payingGroupId: 'sales',
    conversationId: 'chat', turnId: 'turn', threadId: 'thread', computerId: 'computer',
    generation: 1, allowanceCents: 1000 };
  await actor.setRootAllowance(binding, 1);
  const allocation = await nats.store.readEvent(await nats.store.head('budget-test'));
  const data = { ...example('routine.run_activation_admitted'),
    admission: { eventId: allocation.event.id, position: allocation.sequence } };
  const admitted = { ...event('admitted', 'routine-orders', 'routine.run_activation_admitted'),
    source: 'opencrane-server', principal: { kind: 'system' as const, id: 'opencrane-server' }, data };
  await nats.seed([admitted]);
  input.expectedPosition = await nats.store.head('routine-orders');
}
async function admittedRun() {
  await admit();
  input.cause = await settings();
  await savesOnce();
}
it('accepts deactivation after the occupied run admission', admittedRun);

async function changedLifecycle(field: string) {
  const data = { ...example('routine.updated'), status: 'active', [field]: 2 };
  const updated = { ...routine('routine.created'), id: 'updated', commandId: 'updated',
    type: 'routine.updated', data };
  await nats.seed([updated]);
  input.expectedPosition = await nats.store.head('routine-orders');
  input.cause = await settings();
  const expectedField = `expected${field[0]!.toUpperCase()}${field.slice(1)}`;
  const request = { ...input, [expectedField]: 2 };
  const before = await nats.store.head();
  await expect(pause(request)).rejects.toThrow(/^Routine assistant pause refused$/u);
  expect(await nats.store.head()).toBe(before);
}
it.each(['definitionRevision', 'scheduleRevision', 'controlRevision'])(
  'refuses a later lifecycle with changed %s even with fresh expected values', changedLifecycle);
