import { expect, it } from 'vitest';
import { natsFixture } from '@opencrane/event-store/testing';
import { BudgetActor, envelope, history } from '../src/actor.ts';
import { applyBudget, costCents, emptyBudget, priceTableId, totals } from '../src/state.ts';

const choice = { providerId: 'primary', bindingSequence: 42 };
const call = {
  ...choice, model: 'gpt-6-luna', priceTableId, computerId: 'computer',
  assistantId: 'assistant', requesterId: 'alice', conversationId: 'conversation',
  turnId: 'turn', threadId: 'thread', payingGroupId: 'group',
  contextDigest: 'a'.repeat(64), requestId: 'request',
};
const incompleteChoices = [{ providerId: 'primary' }, { bindingSequence: 42 }];

function refusesIncompleteBudgetReplay(patch: Record<string, unknown>) {
  const state = emptyBudget();
  const legacyCall = { ...call, providerId: undefined, bindingSequence: undefined };
  const modelCall = { ...legacyCall, ...patch };
  const payload = {
    reservationId: 'reservation', permitId: 'reservation', amountCents: 12,
    payingGroupId: 'group', assistantId: 'assistant', modelCall,
  };
  const validPayload = { ...payload, modelCall: call };
  const saved = envelope('test', 'budget-test', 'budget.reserved', validPayload);
  // Test replay directly because append validation would otherwise hide this check.
  const malformed = { ...saved, data: payload };
  function replay() {
    applyBudget(state, malformed, 1);
  }
  expect(replay).toThrow();
  expect(state.reservations).toHaveLength(0);
}
it.each(incompleteChoices)('refuses an incomplete provider choice during budget replay %j',
  refusesIncompleteBudgetReplay);

async function settlesProviderReservationOnce() {
  const nats = await natsFixture();
  try {
    const actor = new BudgetActor(nats.store, 'test');
    await actor.start(100, 100, 'group');
    const permitId = await actor.reserve(call, 12);
    const admission = {
      requestId: call.requestId, permitId, route: 'model', outcome: 'allow',
      reason: 'model_allowed', contextDigest: call.contextDigest,
    };
    const allowed = envelope('test', 'decision-request', 'decision.recorded', admission);
    const allowCommand = { event: allowed, expectedSequence: 0 };
    await nats.store.append(allowCommand);
    const settledCents = costCents(call.model, 1000, 120);
    expect(settledCents).toBeGreaterThan(0);
    const usage = { inputTokens: 1000, outputTokens: 120, priceTableId };
    const observed = {
      permitId, computerId: call.computerId, tool: call.model, destination: 'openai',
      costCents: settledCents, outcome: 'success', usage,
    };
    const effect = envelope('test', `effect-${permitId}`, 'effect.observed', observed);
    const effectCommand = { event: effect, expectedSequence: 0 };
    await nats.store.append(effectCommand);
    await actor.settleRecorded(permitId, effect.id);
    await actor.settleRecorded(permitId, effect.id);
    const recovered = new BudgetActor(nats.store, 'test');
    await recovered.start();
    await recovered.settleRecorded(permitId, effect.id);
    expect(recovered.state.reservations).toEqual(actor.state.reservations);
    const expectedReservation = { call, amountCents: 12, settledCents };
    const expectedReservations = [expect.objectContaining(expectedReservation)];
    expect(recovered.state.reservations).toEqual(expectedReservations);
    const expectedTotals = { reservedCents: 0, monthCents: settledCents };
    expect(totals(recovered.state, new Date())).toMatchObject(expectedTotals);
    const rows = await history(nats.store, 'budget-test', 'test');
    function isSettlement(row: typeof rows[number]) {
      return row.event.type === 'budget.settled';
    }
    const settlements = rows.filter(isSettlement);
    expect(settlements).toHaveLength(1);
    const expectedSettlement = { permitId, settledCents };
    expect(settlements[0]?.event.data).toMatchObject(expectedSettlement);
  } finally {
    await nats.close();
  }
}
it('settles a provider reservation once after redelivery and restart with its original metadata',
  settlesProviderReservationOnce);
