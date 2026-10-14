import { setTimeout as delay } from 'node:timers/promises';
import { jetstreamManager } from '@nats-io/jetstream';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { natsFixture } from '@opencrane/event-store/testing';
import { databases } from '@opencrane/authz/testing';
import { pgDb, ProjectionRunner } from '@opencrane/projections';
import { createLogger } from '@opencrane/observability';
import { BudgetActor, budgetSummary, envelope, history, priceTableId,
  budgets, readBudget, totals } from '../src/index.ts';
import { replayBudgets } from '../src/state.ts';
import { rootTotals } from '../src/root-budget.ts';

let nats: Awaited<ReturnType<typeof natsFixture>>;
let actor: BudgetActor;
let clock: Date;
const binding = { requesterId: 'alice', conversationId: 'conversation', turnId: 'turn',
  threadId: 'thread', assistantId: 'assistant', computerId: 'computer', generation: 1,
  payingGroupId: 'group', allowanceCents: 1000 };
const call = { requesterId: 'alice', conversationId: 'conversation', turnId: 'turn',
  threadId: 'thread', assistantId: 'assistant', computerId: 'computer', generation: 1,
  payingGroupId: 'group', model: 'gpt-6-luna', priceTableId,
  contextDigest: '0'.repeat(64) };
function now() { return clock; }
async function setup() {
  nats = await natsFixture();
  clock = new Date('2026-10-10T12:00:00Z');
  actor = new BudgetActor(nats.store, 'test', now);
  await actor.start(10_000, 10_000, 'group');
}
async function close() { await nats.close(); }
beforeEach(setup);
afterEach(close);
async function reserve(rootId: string, cents: number) {
  return actor.reserve(call, cents, undefined, undefined, rootId);
}
async function settle(reservationId: string, settledCents: number) {
  const data = { reservationId, permitId: reservationId, settledCents,
    outcome: 'settled', resolvedBy: 'owner',
    evidence: [{ kind: 'provider_receipt', reference: 'receipt',
      digest: '0'.repeat(64), amountCents: settledCents }] };
  const event = { ...envelope('test', `effect-${reservationId}`, 'effect.resolved', data),
    principal: { kind: 'human' as const, id: 'owner' } };
  await actor.settle(event);
}
async function usedRoot() {
  const root = await actor.setRootAllowance(binding, 240);
  const first = await reserve(root.rootId, 240);
  await settle(first, 240);
  await reserve(root.rootId, 110);
  return root;
}
async function refusesOnlyRoot() {
  const root = await usedRoot();
  expect(rootTotals(actor.state, root.rootId)).toEqual({
    settledCents: 240, heldCents: 110, availableCents: 650 });
  const before = await nats.store.head();
  await expect(reserve(root.rootId, 651)).rejects.toMatchObject({
    reason: 'allowance_exhausted', availableCents: 650 });
  const rows = await history(nats.store, 'budget-test', 'test');
  expect(rows.at(-1)?.event).toMatchObject({ type: 'budget.root_stopped',
    data: { rootId: root.rootId, reason: 'allowance_exhausted', attemptedBoundCents: 651,
      availableCents: 650 } });
  expect(await nats.store.head()).toBe(before + 1);
  const other = { ...binding, turnId: 'other', threadId: 'other' };
  const second = await actor.setRootAllowance(other, 1);
  await actor.reserve({ ...call, turnId: 'other', threadId: 'other' }, 1,
    undefined, undefined, second.rootId);
  expect(budgetSummary(actor.state, clock)).not.toHaveProperty('roots');
}
it('saves only a root stop for 651 cents and lets another root use the payer', refusesOnlyRoot);
async function fitsExactly() {
  const root = await usedRoot();
  await reserve(root.rootId, 650);
  expect(rootTotals(actor.state, root.rootId).availableCents).toBe(0);
  for (const scope of [undefined, { scope: 'paying_group' as const, scopeId: 'group' },
    { scope: 'assistant' as const, scopeId: 'assistant' }]) {
    expect(totals(actor.state, clock, scope)).toMatchObject({ monthCents: 240, reservedCents: 760 });
  }
}
it('accepts 650 and counts each call once at every scope', fitsExactly);
async function checksAdmission() {
  const earlier = { ...call, turnId: 'earlier' };
  const reservation = await actor.reserve(earlier, 20);
  await settle(reservation, 10);
  await actor.reserve(earlier, 30);
  await actor.configure({ scope: 'global', dailyCeilingCents: 540, ceilingCents: 940,
    setBy: 'owner' });
  await actor.configure({ scope: 'paying_group', scopeId: 'group', ceilingCents: 290,
    setBy: 'owner' });
  await actor.configure({ scope: 'assistant', scopeId: 'assistant', ceilingCents: 220,
    setBy: 'owner' });
  const before = await nats.store.head();
  await expect(actor.setRootAllowance(binding, 1)).rejects.toMatchObject({ availableCents: 180 });
  await expect(actor.setRootAllowance({ ...binding, allowanceCents: 180 }, 181))
    .rejects.toMatchObject({ availableCents: 180 });
  expect(await nats.store.head()).toBe(before);
  await actor.setRootAllowance({ ...binding, allowanceCents: 180 }, 180);
  expect(totals(actor.state, clock)).toMatchObject({ monthCents: 10, reservedCents: 30 });
  await actor.configure({ scope: 'assistant', scopeId: 'assistant', ceilingCents: 0,
    setBy: 'owner' });
  await expect(actor.setRootAllowance({ ...binding, turnId: 'new', allowanceCents: 1 }, 1))
    .rejects.toMatchObject({ reason: 'ceiling_stop' });
}
it('honours every remaining cap and the first call without allocating money', checksAdmission);
async function concurrentCalls() {
  const root = await usedRoot();
  const results = await Promise.allSettled([reserve(root.rootId, 400), reserve(root.rootId, 300)]);
  function fulfilled(result: PromiseSettledResult<string>) { return result.status === 'fulfilled'; }
  expect(results.filter(fulfilled)).toHaveLength(1);
  expect(rootTotals(actor.state, root.rootId)).toMatchObject({ heldCents: 510 });
  await expect(reserve(root.rootId, 1)).rejects.toMatchObject({ reason: 'allowance_exhausted' });
}
it('serialises competing holds and keeps the first stop', concurrentCalls);
async function matchesBinding() {
  const root = await actor.setRootAllowance(binding, 1);
  await actor.configure({ scope: 'global', ceilingCents: 30_000, setBy: 'owner' });
  const before = await nats.store.head();
  expect(await actor.setRootAllowance(binding, 1)).toEqual(root);
  for (const field of ['requesterId', 'threadId', 'assistantId', 'computerId', 'generation',
    'payingGroupId', 'allowanceCents'] as const) {
    const value = typeof binding[field] === 'number' ? 2 : 'changed';
    await expect(actor.setRootAllowance({ ...binding, [field]: value }, 1))
      .rejects.toThrow('Root binding conflict');
    if (field !== 'allowanceCents') {
      await expect(actor.reserve({ ...call, [field]: value }, 1, undefined, undefined, root.rootId))
        .rejects.toThrow('Root binding conflict');
    }
  }
  await expect(actor.reserve(call, 1)).rejects.toThrow('Root binding conflict');
  await expect(reserve('unknown', 1)).rejects.toThrow('Root binding conflict');
  expect(await nats.store.head()).toBe(before);
}
it('requires the saved binding and root id and returns unchanged retries without appending',
  matchesBinding);
async function stopsOnCeiling() {
  const root = await actor.setRootAllowance(binding, 1);
  await actor.reserve({ ...call, turnId: 'unrooted' }, 9500);
  await expect(reserve(root.rootId, 600)).rejects.toMatchObject({ reason: 'ceiling_stop' });
  const rows = await history(nats.store, 'budget-test', 'test');
  const stopId = rows.at(-2)?.event.id;
  expect(rows.at(-2)?.event.type).toBe('budget.exhausted');
  expect(rows.at(-1)?.event).toMatchObject({ type: 'budget.root_stopped',
    data: { reason: 'ceiling_stop', stopId } });
}
it('saves existing ceiling exhaustion and links the root stop to it', stopsOnCeiling);
async function keepsAdmissionPosition() {
  const root = await actor.setRootAllowance(binding, 1);
  await actor.configure({ scope: 'global', dailyCeilingCents: 0, ceilingCents: 0, setBy: 'owner' });
  await actor.configure({ scope: 'global', dailyCeilingCents: 20_000, ceilingCents: 20_000,
    setBy: 'owner' });
  await expect(actor.reserve(call, 1, undefined, Number.MAX_SAFE_INTEGER, root.rootId))
    .rejects.toMatchObject({ reason: 'ceiling_stop' });
}
it('uses the root admission position even after caps recover before its first call',
  keepsAdmissionPosition);
async function replaysLifetime() {
  const root = await actor.setRootAllowance(binding, 110);
  const reservation = await reserve(root.rootId, 110);
  await settle(reservation, 240);
  await settle(reservation, 330);
  expect(rootTotals(actor.state, root.rootId)).toEqual({
    settledCents: 330, heldCents: 110, availableCents: 560 });
  await expect(reserve(root.rootId, 561)).rejects.toThrow();
  await actor.configure({ scope: 'global', ceilingCents: 30_000, dailyCeilingCents: 30_000,
    setBy: 'owner' });
  clock = new Date('2026-11-01T12:00:00Z');
  await actor.period();
  actor = new BudgetActor(nats.store, 'test', now);
  await actor.start();
  const before = await nats.store.head();
  await expect(reserve(root.rootId, 1)).rejects.toThrow();
  expect(await nats.store.head()).toBe(before);
  await settle(reservation, 400);
  const storage = await databases();
  try {
    const db = pgDb(storage.queue);
    const logger = createLogger('test', { level: 'silent' });
    const runner = new ProjectionRunner(db, nats.store, logger);
    const position = await nats.store.head();
    await runner.initialise(budgets);
    await runner.run(budgets);
    await runner.initialise(replayBudgets);
    await runner.run(replayBudgets);
    expect(await readBudget(db, 'test')).toEqual(actor.state);
    const replay = await db.query<{ state: unknown }>('SELECT state FROM model_budgets_replay');
    expect(replay.rows[0]?.state).toEqual(JSON.parse(JSON.stringify(actor.state)));
    expect(rootTotals(actor.state, root.rootId)).toEqual({
      settledCents: 400, heldCents: 110, availableCents: 490 });
    expect(await nats.store.head()).toBe(position);
  } finally { await storage.close(); }
}
it('keeps conflicting evidence, late settlement and lifetime totals through restart and PG replay',
  replaysLifetime);
async function recoversLostReply() {
  const manager = await jetstreamManager(nats.connection);
  await manager.streams.update('EVENTS', { duplicate_window: 1_000_000_000 });
  const append = nats.store.append.bind(nats.store);
  async function loseReply(input: Parameters<typeof append>[0]) {
    await append(input);
    nats.store.append = append;
    return { status: 'unavailable' as const, cause: new Error('Reply lost') };
  }
  nats.store.append = loseReply;
  await expect(actor.setRootAllowance(binding, 1)).rejects.toThrow();
  await delay(1100);
  actor = new BudgetActor(nats.store, 'test', now);
  await actor.start();
  const before = await nats.store.head();
  const root = await actor.setRootAllowance(binding, 1);
  expect(await actor.setRootAllowance(binding, 1)).toEqual(root);
  expect(await nats.store.head()).toBe(before);
}
it('recovers a lost reply beyond NATS deduplication without another allocation', recoversLostReply);
async function rejectsOldLeader(operation: string) {
  const root = await actor.setRootAllowance(binding, 1);
  const old = actor;
  actor = new BudgetActor(nats.store, 'test', now);
  await actor.start();
  const before = await nats.store.head();
  if (operation === 'stop') {
    await expect(old.reserve(call, 1001, undefined, undefined, root.rootId)).rejects.toThrow('fence');
  } else {
    await expect(old.setRootAllowance({ ...binding, turnId: 'new' }, 1)).rejects.toThrow('fence');
  }
  expect(await nats.store.head()).toBe(before);
}
it.each(['stop', 'set'])('prevents a replaced leader from saving a root %s', rejectsOldLeader);

async function rejectsInvalidAllowance(allowanceCents: number) {
  const before = await nats.store.head();
  await expect(actor.setRootAllowance({ ...binding, allowanceCents }, 1))
    .rejects.toThrow('Invalid root allowance');
  expect(await nats.store.head()).toBe(before);
}
it.each([0, 1001, 1.5, Number.MAX_SAFE_INTEGER + 1])(
  'refuses an invalid allowance of %s without writing', rejectsInvalidAllowance);

async function refusesLateAllocation() {
  await actor.reserve(call, 100);
  await expect(actor.setRootAllowance(binding, 1)).rejects.toThrow('Root binding conflict');
}
it('refuses an allowance after that turn already held money without a root', refusesLateAllocation);
