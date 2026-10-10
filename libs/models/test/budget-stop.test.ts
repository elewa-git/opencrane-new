import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { countReads, natsFixture } from '@opencrane/event-store/testing';
import { BudgetActor, budgetSummary, envelope, history, priceTableId } from '../src/index.ts';

let nats: Awaited<ReturnType<typeof natsFixture>>;
let actor: BudgetActor;
let clock: Date;
function now() {
  return clock;
}
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
async function close() {
  await nats.close();
}
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
    periodStart: scope === 'daily' ? '2026-10-10T00:00:00.000Z' : '2026-10-01T00:00:00.000Z',
    resetAt: scope === 'daily' ? '2026-10-11T00:00:00.000Z' : '2026-11-01T00:00:00.000Z',
  } ] } ] });
}
it.each(scopes)('keeps a refused %s limit stopped and isolates other scopes',
  stopsOnlyAffectedScope);

async function stopsAtConfiguration(configuration: (typeof loweredCeilings)[number]) {
  const { ceilingCents, existing } = configuration;
  await actor.reserve(call('old'), 5);
  if (existing) {
    await limit('paying_group', 50);
  }
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
const loweredCeilings = [
  { ceilingCents: 0, existing: false }, { ceilingCents: 5, existing: false },
  { ceilingCents: 0, existing: true }, { ceilingCents: 5, existing: true },
];
it.each(loweredCeilings)('stops at $ceilingCents (existing: $existing) with one append',
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
  await expect(actor.reserve(call('new'), 1)).rejects.toThrow('spending cap');
  await expect(actor.reserve(call('after-reset'), 1)).resolves.toBeTypeOf('string');
  await limit(scope, 100);
  await expect(actor.reserve(call('new'), 1)).rejects.toThrow('spending cap');
  await expect(actor.reserve(call('old'), 1)).rejects.toThrow('spending cap');
  const recovered = new BudgetActor(nats.store, 'test', now);
  await recovered.start();
  const expected = budgetSummary(actor.state, clock);
  expect(budgetSummary(recovered.state, clock)).toEqual({ ...expected,
    sequence: recovered.state.sequence });
  await expect(recovered.reserve(call('old'), 1)).rejects.toThrow('spending cap');
  await expect(recovered.reserve(call('new'), 1)).rejects.toThrow('spending cap');
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
  const summary = budgetSummary(actor.state, clock);
  const reasons = summary.stops[0]?.reasons;
  expect(reasons).toHaveLength(4);
  expect(reasons).toEqual(expect.arrayContaining([
    expect.objectContaining({ scope: 'global', kind: 'monthly' }),
    expect.objectContaining({ scope: 'global', kind: 'daily' }),
    expect.objectContaining({ scope: 'paying_group' }),
    expect.objectContaining({ scope: 'assistant' }),
  ]));
  const rows = await history(nats.store, 'budget-test', 'test');
  function exhausted(row: (typeof rows)[number]) {
    return row.event.type === 'budget.exhausted';
  }
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
  await expect(actor.reserve(call('new'), 1)).rejects.toThrow('spending cap');
  await expect(actor.reserve(call('fresh'), 1)).resolves.toBeTypeOf('string');
}
it('replays old scope-only exhaustion without losing its stopped work', replaysLegacyStop);

async function settlementDoesNotResume() {
  await actor.reserve(call('old'), 5);
  await limit('paying_group', 10);
  await expect(actor.reserve(call('refused'), 6)).rejects.toThrow('spending cap');
  await actor.releaseUndispatched(actor.state.reservations[0]!.id);
  await expect(actor.reserve(call('new'), 1)).rejects.toThrow('spending cap');
  await actor.configure({ scope: 'global', ceilingCents: 200, setBy: 'alice' });
  await expect(actor.reserve(call('new'), 1)).rejects.toThrow('spending cap');
}
it('keeps a group stop after settlement frees money and the global ceiling changes',
  settlementDoesNotResume);

async function dailyEditDoesNotResumeMonthly() {
  await limit('global', 10);
  await expect(actor.reserve(call('refused'), 11)).rejects.toThrow('spending cap');
  await actor.configure({ scope: 'global', ceilingCents: 10, dailyCeilingCents: 200,
    defaultPayingGroupId: 'other', setBy: 'alice' });
  await expect(actor.reserve(call('new'), 1)).rejects.toThrow('spending cap');
  await limit('global', 100);
  await expect(actor.reserve(call('new'), 1)).rejects.toThrow('spending cap');
  await expect(actor.reserve(call('fresh'), 1)).resolves.toBeTypeOf('string');
}
it('keeps a monthly stop when only the daily ceiling and default payer change',
  dailyEditDoesNotResumeMonthly);

async function loweredAboveUsage() {
  await actor.reserve(call('old'), 5);
  await limit('global', 6);
  await expect(actor.reserve(call('old'), 1)).resolves.toBeTypeOf('string');
  await expect(actor.reserve(call('refused'), 1)).rejects.toThrow('spending cap');
}
it('lets a lowered ceiling above usage fill exactly before an over-cap attempt stops it',
  loweredAboveUsage);

async function keepsOmittedDailyLimit() {
  const old = envelope('legacy', 'budget-legacy', 'budget.ceiling_set', {
    scope: 'global', ceilingCents: 100, setBy: 'alice', defaultPayingGroupId: 'group',
  });
  await nats.seed([old]);
  const legacy = new BudgetActor(nats.store, 'legacy', now);
  await legacy.start();
  await expect(legacy.reserve(call('new'), 1)).rejects.toThrow('spending cap');
  expect(budgetSummary(legacy.state, clock)).toMatchObject({ dailyCeilingCents: 0 });
}
it('keeps the zero daily limit when older initial settings omit it', keepsOmittedDailyLimit);

async function savesExistingStopRefusal(zeroCeiling: boolean) {
  const held = await actor.reserve(call('old'), 5);
  await limit('paying_group', zeroCeiling ? 0 : 10);
  if (!zeroCeiling) {
    await expect(actor.reserve(call('exhausts'), 6)).rejects.toThrow('spending cap');
  }
  clock = new Date('2026-11-01T00:00:00Z');
  if (!zeroCeiling) {
    clock = new Date('2026-10-10T12:00:00Z');
  }
  const stop = actor.state.stops[0]!;
  const before = await nats.store.head('budget-test');
  const reads = countReads(nats.store);
  await expect(actor.reserve(call('refused-later'), 1, fresh)).rejects.toThrow('spending cap');
  expect(reads.calls).toEqual([]);
  expect(await nats.store.head('budget-test')).toBe(before + 1);
  const rows = await history(nats.store, 'budget-test', 'test');
  expect(rows.at(-1)).toMatchObject({ sequence: before + 1, event: {
    type: 'budget.exhausted', data: { stopId: stop.id,
      work: { conversationId: 'conversation', turnId: 'refused-later' } },
  } });
  expect(actor.state.stops).toHaveLength(1);
  expect(actor.state.stoppedWork).toContainEqual({ conversationId: 'conversation',
    turnId: 'refused-later', stopId: stop.id });
  reads.clear();
  await expect(actor.reserve(call('refused-later'), 1, fresh)).rejects.toThrow('spending cap');
  expect(reads.calls).toEqual([]);
  expect(await nats.store.head('budget-test')).toBe(before + 1);
  await actor.releaseUndispatched(held);
  await expect(actor.reserve(call('refused-later'), 1)).rejects.toThrow('spending cap');
  await limit('paying_group', 100);
  await expect(actor.reserve(call('refused-later'), 1)).rejects.toThrow('spending cap');
  clock = new Date('2026-12-01T00:00:00Z');
  await actor.period();
  await expect(actor.reserve(call('refused-later'), 1)).rejects.toThrow('spending cap');
  const recovered = new BudgetActor(nats.store, 'test', now);
  await recovered.start();
  await expect(recovered.reserve(call('refused-later'), 1)).rejects.toThrow('spending cap');
  const otherConversation = { ...call('refused-later'), conversationId: 'other-conversation' };
  await expect(recovered.reserve(otherConversation, 1)).resolves.toBeTypeOf('string');
  await expect(recovered.reserve(call('fresh'), 1)).resolves.toBeTypeOf('string');
}
it.each([false, true])(
  'saves a refused identity once without reads and retains it after recovery (zero: %s)',
  savesExistingStopRefusal);

async function rechecksAccessBeforeSavingRefusal(existingStop: boolean) {
  await limit('paying_group', existingStop ? 0 : 1);
  const before = await nats.store.head('budget-test');
  async function revoked() {
    throw new Error('Access revoked');
  }
  await expect(actor.reserve(call('revoked'), 2, revoked)).rejects.toThrow('Access revoked');
  expect(await nats.store.head('budget-test')).toBe(before);
  await limit('paying_group', 100);
  await expect(actor.reserve(call('revoked'), 1)).resolves.toBeTypeOf('string');
}
it.each([false, true])('rechecks access before saving a refusal (existing stop: %s)',
  rechecksAccessBeforeSavingRefusal);

async function refusesUnsavedIdentityAfterAppendConflict() {
  await limit('paying_group', 0);
  const replacement = new BudgetActor(nats.store, 'test', now);
  await replacement.start();
  const before = await nats.store.head('budget-test');
  await expect(actor.reserve(call('refused'), 1)).rejects.toThrow('Budget writer lost its fence');
  await expect(actor.reserve(call('refused'), 1)).rejects.toThrow('Budget writer unavailable');
  expect(await nats.store.head('budget-test')).toBe(before);
  expect(actor.state.stoppedWork).toEqual([]);
}
it('stops the stale writer when saving a refused identity conflicts',
  refusesUnsavedIdentityAfterAppendConflict);

async function serialisesConfigurationAndReservation(configurationFirst: boolean) {
  const before = await nats.store.head('budget-test');
  const append = nats.store.append.bind(nats.store);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  async function pauseFirstAppend(command: Parameters<typeof append>[0]) {
    entered.resolve();
    await release.promise;
    return append(command);
  }
  const blocked = vi.spyOn(nats.store, 'append').mockImplementationOnce(pauseFirstAppend);
  const payload = { scope: 'assistant', scopeId: 'assistant', ceilingCents: 5,
    setBy: 'alice' };
  let configuration: ReturnType<BudgetActor['configure']>;
  let reservation: ReturnType<BudgetActor['reserve']>;
  try {
    if (configurationFirst) {
      configuration = actor.configure(payload, 'racing-configuration', before);
      await entered.promise;
      reservation = actor.reserve(call('racing'), 5);
    } else {
      reservation = actor.reserve(call('racing'), 5);
      await entered.promise;
      configuration = actor.configure(payload, 'racing-configuration', before);
    }
    release.resolve();
    await expect(reservation).resolves.toBeTypeOf('string');
    expect(await configuration).toEqual({ status: configurationFirst ? 'appended' : 'conflict' });
    if (!configurationFirst) {
      expect(actor.state.ceilings).toEqual([]);
      expect(await nats.store.head('budget-test')).toBe(before + 1);
      expect(await actor.configure(payload, 'retried-configuration', actor.state.sequence))
        .toEqual({ status: 'appended' });
      await expect(actor.reserve(call('racing'), 1)).rejects.toThrow('spending cap');
    }
    expect(await nats.store.head('budget-test')).toBe(before + 2);
    expect(actor.state.reservations).toHaveLength(1);
    expect(actor.state.ceilings).toEqual([{ scope: 'assistant', scopeId: 'assistant',
      ceilingCents: 5 }]);
  } finally {
    release.resolve();
    blocked.mockRestore();
  }
}
it.each([false, true])('orders configuration against reservation (configuration first: %s)',
  serialisesConfigurationAndReservation);

async function stopsAtFirstAssistantCeiling(ceilingCents: number) {
  await actor.reserve(call('old'), 5);
  const before = await nats.store.head('budget-test');
  await limit('assistant', ceilingCents);
  expect(await nats.store.head('budget-test')).toBe(before + 1);
  await expect(actor.requireOpenReservation(actor.state.reservations[0]!.id, fresh))
    .rejects.toThrow('spending cap');
  const stop = actor.state.stops[0]!;
  expect(stop).toMatchObject({ position: before + 1, reasons: [{
    scope: 'assistant', scopeId: 'assistant', kind: 'monthly', ceilingCents,
    settledCents: 0, reservedCents: 5, attemptedBoundCents: 0,
    configurationId: stop.id, reason: ceilingCents === 0 ? 'zero_ceiling' : 'ceiling_lowered',
  }] });
  await limit('assistant', 100);
  await expect(actor.reserve(call('old'), 1)).rejects.toThrow('spending cap');
  await expect(actor.reserve(call('new'), 1)).resolves.toBeTypeOf('string');
}
it.each([0, 5])('stops at the first assistant ceiling of %s cents with one append',
  stopsAtFirstAssistantCeiling);
