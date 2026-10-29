import { z } from 'zod';
import { routineDueSchema } from '../../../libs/events/src/routines.ts';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { event, natsFixture } from '@opencrane/event-store/testing';
import { getEventDefinition, routineControlSchema, type EventEnvelope } from '@opencrane/events';
import { BudgetActor, envelope, priceTableId, readRootStopEvidence } from '@opencrane/models';
import { rootTotals } from '../../../libs/models/src/root-budget.ts';
import { applyRoutineStop } from '../src/routine-stop-budget.ts';

let nats: Awaited<ReturnType<typeof natsFixture>>;
let actor: BudgetActor;
let rootId: string;
let earlier: { eventId: string; position: number };
const due = routineDueSchema.parse(getEventDefinition('routine.due')!.example);
const binding = { requesterId: 'alice', conversationId: 'chat', turnId: 'turn',
  threadId: 'thread', assistantId: 'sales-assistant', computerId: 'computer', generation: 1,
  payingGroupId: 'sales', allowanceCents: 1000 };
const { allowanceCents: _allowance, ...callBinding } = binding;
const call = { ...callBinding, model: 'gpt-6-luna', priceTableId, contextDigest: '0'.repeat(64) };
async function save(type: string, subject: string, data: unknown, silo = 'test') {
  const saved: EventEnvelope = { ...event(randomUUID(), subject, type), silo, data,
    source: 'opencrane-server', principal: { kind: 'system' as const, id: 'opencrane-server' }
  };
  if (type === 'routine.created') saved.principal = { kind: 'human', id: 'alice' };
  await nats.seed([saved]);
  return { eventId: saved.id, position: await nats.store.head(subject) };
}
function example(type: string) {
  return z.record(z.string(), z.unknown()).parse(getEventDefinition(type)!.example);
}
async function setup() {
  nats = await natsFixture();
  actor = new BudgetActor(nats.store, 'test');
  await actor.start(10_000, 10_000, 'sales');
  earlier = await settings();
  const created = { ...example('routine.created'), status: 'active' };
  await save('routine.created', 'routine-orders', created);
  await save('routine.due', 'routine-orders', due);
}
async function cleanup() {
  await nats?.close();
}
beforeEach(setup);
afterEach(cleanup);
async function settings(active = false, assistantId = 'sales-assistant', silo = 'test') {
  return save('assistant.settings_changed', `assistant-${assistantId}`,
    { assistantId, changedBy: 'admin', changedFields: ['active'], active }, silo);
}
async function pause(cause: unknown, changes: Record<string, unknown> = {}) {
  const original = routineControlSchema.parse(getEventDefinition('routine.paused')!.example);
  const data = { ...original, controlRevision: 2, source: 'access',
    actorId: 'opencrane-server', reason: 'assistant_inactive', affectedRun: 'occurrence',
    cause, ...changes };
  const saved = await save('routine.paused', 'routine-orders', data);
  return { routineId: 'orders', ...saved };
}
async function preservesStop() {
  rootId = (await actor.setRootAllowance(binding, 1)).rootId;
  const allocation = await nats.store.readEvent(await nats.store.head('budget-test'));
  const admitted = { ...example('routine.run_activation_admitted'),
    admission: { eventId: allocation.event.id, position: allocation.sequence } };
  await save('routine.run_activation_admitted', 'routine-orders', admitted);
  const held = await actor.reserve(call, 1, undefined, undefined, rootId);
  await actor.uncertain(held, 'settle_timeout');
  const otherBinding = { ...binding, turnId: 'another', threadId: 'another' };
  const other = await actor.setRootAllowance(otherBinding, 1);
  const source = await pause(await settings());
  await settings(true);
  const before = await nats.store.head();
  expect(await applyRoutineStop(nats.store, 'test', source, actor)).toEqual({ status: 'disabled' });
  expect(await applyRoutineStop(nats.store, 'test', source, actor,
    { enabled: true, replay: true })).toEqual({ status: 'disabled' });
  expect(await nats.store.head()).toBe(before);
  expect(await applyRoutineStop(nats.store, 'test', source, actor, { enabled: true }))
    .toEqual({ status: 'confirmed' });
  expect(rootTotals(actor.state, rootId).heldCents).toBe(1);
  expect(actor.state.roots[0]?.stop).toMatchObject({ sourceEventId: source.eventId });
  expect(actor.state.roots[1]?.stop).toBeUndefined();
  const otherCall = { ...call, turnId: 'another', threadId: 'another' };
  await actor.reserve(otherCall, 1, undefined, undefined, other.rootId);
  await nats.stop();
  await nats.restart();
  actor = new BudgetActor(nats.store, 'test');
  await actor.start();
  const settled = { reservationId: held, permitId: held, settledCents: 1234, outcome: 'settled',
    resolvedBy: 'owner', evidence: [{ kind: 'provider_receipt', reference: 'receipt',
      digest: '0'.repeat(64), amountCents: 1234 }] };
  const resolution = envelope('test', `effect-${held}`, 'effect.resolved', settled);
  resolution.principal = { kind: 'human', id: 'owner' };
  await actor.settle(resolution);
  expect(rootTotals(actor.state, rootId)).toEqual({
    settledCents: 1234, heldCents: 0, availableCents: 0 });
  await expect(actor.reserve(call, 1, undefined, undefined, rootId))
    .rejects.toMatchObject({ reason: 'routine_stop' });
  expect(await applyRoutineStop(nats.store, 'test', source, actor, { enabled: true }))
    .toEqual({ status: 'confirmed' });
  const proof = await readRootStopEvidence(nats.store, 'routine-orders', source.position);
  expect(proof.routine).toMatchObject({ status: 'paused', executionAvailable: false });
  expect(proof.routine?.activeRun).toEqual(due);
  expect(actor.state.dispatches).toEqual([]);
}
it('keeps the frozen root stopped after reactivation and restart, with full late cost', preservesStop);

async function forgedEvidence(kind: string) {
  rootId = (await actor.setRootAllowance(binding, 1)).rootId;
  let cause: unknown = await settings();
  const changes: Record<string, unknown> = {};
  if (kind === 'assistant') cause = await settings(false, 'another');
  if (kind === 'silo') cause = await settings(false, 'sales-assistant', 'foreign');
  if (kind === 'active') cause = await settings(true);
  if (kind === 'unrelated settings') {
    cause = await save('assistant.settings_changed', 'assistant-sales-assistant',
      { assistantId: 'sales-assistant', changedBy: 'admin', changedFields: ['model'] });
  }
  if (kind === 'before due') cause = earlier;
  if (kind === 'missing cause') cause = undefined;
  if (kind === 'forged cause') cause = { eventId: 'forged', position: await nats.store.head() };
  if (kind === 'later cause') cause = { eventId: 'later', position: await nats.store.head() + 2 };
  if (kind === 'occurrence') changes['affectedRun'] = 'another';
  if (kind === 'definitionRevision') changes[kind] = 2;
  if (kind === 'scheduleRevision') changes[kind] = 2;
  if (kind === 'controlRevision') changes[kind] = 3;
  if (kind === 'reason') changes[kind] = 'owner_removed';
  const source = await pause(cause, changes);
  const before = await nats.store.head();
  await expect(readRootStopEvidence(nats.store, 'routine-orders', source.position))
    .rejects.toThrow(/^Root stop evidence refused$/u);
  await expect(applyRoutineStop(nats.store, 'test', source, actor, { enabled: true }))
    .rejects.toThrow(/^Routine budget Stop unavailable$/u);
  expect(await nats.store.head()).toBe(before);
  await actor.reserve(call, 1, undefined, undefined, rootId);
}
it.each(['assistant', 'silo', 'active', 'unrelated settings', 'missing cause', 'forged cause',
  'before due', 'later cause', 'occurrence', 'definitionRevision', 'scheduleRevision', 'controlRevision', 'reason'])(
  'grants no Stop from invalid assistant pause evidence: %s', forgedEvidence);

async function otherAllocation(field: string) {
  const source = await pause(await settings());
  const changed = { ...binding, [field]: 'another' };
  const other = await actor.setRootAllowance(changed, 1);
  const before = await nats.store.head();
  await expect(actor.stopRoot(other.rootId, 'routine_stop', 'routine-orders', source.position))
    .rejects.toThrow(/^Root stop evidence refused$/u);
  expect(await nats.store.head()).toBe(before);
}
it.each(['requesterId', 'assistantId', 'payingGroupId', 'conversationId', 'turnId'])(
  'refuses an allocation with a different frozen %s', otherAllocation);
