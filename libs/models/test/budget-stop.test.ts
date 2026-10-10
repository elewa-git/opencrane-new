import { afterEach, beforeEach, expect, it } from 'vitest';
import { natsFixture } from '@opencrane/event-store/testing';
import { BudgetActor, budgetSummary, envelope, history, priceTableId } from '../src/index.ts';

let nats: Awaited<ReturnType<typeof natsFixture>>;
let actor: BudgetActor;
let clock: Date;
function now() { return clock; }
function call(turnId: string, payingGroupId = 'group', assistantId = 'assistant') {
  return {
    model: 'gpt-6-luna', priceTableId, computerId: 'computer', assistantId,
    requesterId: 'alice', conversationId: 'conversation', turnId, threadId: turnId,
    payingGroupId, contextDigest: '0'.repeat(64),
  };
}
async function initialise() {
  nats = await natsFixture();
  clock = new Date('2026-10-10T12:00:00Z');
  actor = new BudgetActor(nats.store, 'test', now);
  await actor.start(100, 100, 'group');
}
async function close() { await nats.close(); }
beforeEach(initialise);
afterEach(close);
const scopes = ['global', 'paying_group', 'assistant', 'daily'] as const;
type Scope = (typeof scopes)[number];
async function limit(scope: Scope, ceilingCents: number) {
  if (scope === 'daily') {
    return actor.configure({ scope: 'global', ceilingCents: 100, dailyCeilingCents: ceilingCents,
      setBy: 'alice' });
  }
  if (scope === 'global') {
    return actor.configure({ scope, ceilingCents, setBy: 'alice' });
  }
  const scopeId = scope === 'paying_group' ? 'group' : 'assistant';
  return actor.configure({ scope, scopeId, ceilingCents, setBy: 'alice' });
}
async function stopsOnlyAffectedScope(scope: Scope) {
  await limit(scope, 10);
  await actor.reserve(call('old'), 5);
  await expect(actor.reserve(call('refused'), 6)).rejects.toThrow('spending cap');
  await expect(actor.reserve(call('small'), 1)).rejects.toThrow('spending cap');
  if (scope === 'paying_group') {
    await expect(actor.reserve(call('other', 'other-group'), 1)).resolves.toBeTypeOf('string');
  } else if (scope === 'assistant') {
    await expect(actor.reserve(call('other', 'group', 'other-assistant'), 1))
      .resolves.toBeTypeOf('string');
  } else {
    await expect(actor.reserve(call('other', 'other-group', 'other-assistant'), 1))
      .rejects.toThrow('spending cap');
  }
  const summary = budgetSummary(actor.state, clock);
  expect(summary).toMatchObject({ stops: [ { reasons: [ {
    scope: scope === 'daily' ? 'global' : scope,
    kind: scope === 'daily' ? 'daily' : 'monthly', ceilingCents: 10,
    settledCents: 0, reservedCents: 5, attemptedBoundCents: 6,
    periodStart: '2026-10-01T00:00:00.000Z', resetAt: '2026-11-01T00:00:00.000Z',
  } ] } ] });
}
// Daily reasons reset at midnight, rather than at the start of the month.
async function isolates(scope: Scope) {
  if (scope !== 'daily') return stopsOnlyAffectedScope(scope);
  await limit(scope, 10);
  await actor.reserve(call('old'), 5);
  await expect(actor.reserve(call('refused'), 6)).rejects.toThrow('spending cap');
  await expect(actor.reserve(call('small', 'other-group', 'other-assistant'), 1))
    .rejects.toThrow('spending cap');
  expect(budgetSummary(actor.state, clock)).toMatchObject({ stops: [ { reasons: [ {
    kind: 'daily', periodStart: '2026-10-10T00:00:00.000Z',
    resetAt: '2026-10-11T00:00:00.000Z',
  } ] } ] });
}
it.each(scopes)('keeps a refused %s limit stopped and isolates other scopes', isolates);

async function stopsAtConfiguration(ceilingCents: number) {
  await actor.reserve(call('old'), 5);
  await limit('paying_group', 50);
  const before = await nats.store.head('budget-test');
  await limit('paying_group', ceilingCents);
  expect(await nats.store.head('budget-test')).toBe(before + 1);
  await expect(actor.requireOpenReservation(actor.state.reservations[0]!.id, fresh))
    .rejects.toThrow('spending cap');
  await limit('paying_group', 50);
  await expect(actor.reserve(call('old'), 1)).rejects.toThrow('spending cap');
  await expect(actor.reserve(call('new'), 1)).resolves.toBeTypeOf('string');
}
async function fresh() {}
it.each([0, 5])('stops at a lowered ceiling of %s with one configuration append',
  stopsAtConfiguration);

async function recoversOnlyNewWork(scope: Scope) {
  await limit(scope, 10);
  await actor.reserve(call('old'), 5);
  await expect(actor.reserve(call('refused'), 6)).rejects.toThrow('spending cap');
  await actor.configure({ scope: 'assistant', scopeId: 'unrelated', ceilingCents: 200,
    setBy: 'alice' });
  await expect(actor.reserve(call('new'), 1)).rejects.toThrow('spending cap');
  await limit(scope, 10);
  await expect(actor.reserve(call('new'), 1)).rejects.toThrow('spending cap');
  clock = new Date(scope === 'daily' ? '2026-10-11T00:00:00Z' : '2026-11-01T00:00:00Z');
  await actor.period();
  await expect(actor.reserve(call('old'), 1)).rejects.toThrow('spending cap');
  await expect(actor.reserve(call('refused'), 1)).rejects.toThrow('spending cap');
  await expect(actor.reserve(call('new'), 1)).resolves.toBeTypeOf('string');
  await limit(scope, 100);
  await expect(actor.reserve(call('old'), 1)).rejects.toThrow('spending cap');
  const recovered = new BudgetActor(nats.store, 'test', now);
  await recovered.start();
  const expected = budgetSummary(actor.state, clock);
  expect(budgetSummary(recovered.state, clock)).toEqual({ ...expected,
    sequence: recovered.state.sequence });
  await expect(recovered.reserve(call('old'), 1)).rejects.toThrow('spending cap');
  await expect(recovered.reserve(call('fresh'), 1)).resolves.toBeTypeOf('string');
}
it.each(scopes)('recovers new %s work without reopening old work after replay',
  recoversOnlyNewWork);

async function recordsAllReasons() {
  await limit('global', 10);
  await limit('daily', 10);
  await limit('global', 10);
  await limit('paying_group', 10);
  await limit('assistant', 10);
  await expect(actor.reserve(call('refused'), 11)).rejects.toThrow('spending cap');
  expect(budgetSummary(actor.state, clock)).toMatchObject({ stops: [ {
    reasons: [ { scope: 'global', kind: 'monthly' }, { scope: 'global', kind: 'daily' },
      { scope: 'paying_group' }, { scope: 'assistant' } ],
  } ] });
  const rows = await history(nats.store, 'budget-test', 'test');
  function exhausted(row: (typeof rows)[number]) { return row.event.type === 'budget.exhausted'; }
  expect(rows.filter(exhausted)).toHaveLength(1);
}
it('records every binding reason in one exhaustion event', recordsAllReasons);

async function replaysLegacyStop() {
  await actor.reserve(call('old'), 1);
  const legacy = envelope('test', 'budget-test', 'budget.exhausted', { scope: 'global' });
  await nats.seed([legacy]);
  actor = new BudgetActor(nats.store, 'test', now);
  await actor.start();
  await expect(actor.reserve(call('new'), 1)).rejects.toThrow('spending cap');
  await limit('global', 200);
  // The unchanged daily limit still needs its own recovery.
  await limit('daily', 200);
  await expect(actor.reserve(call('old'), 1)).rejects.toThrow('spending cap');
  await expect(actor.reserve(call('new'), 1)).resolves.toBeTypeOf('string');
}
it('replays old scope-only exhaustion without losing its stopped work', replaysLegacyStop);
