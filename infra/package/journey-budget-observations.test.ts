import assert from 'node:assert/strict';
import { test } from 'node:test';
import { budgetAssistantIsReady, budgetChangeIsReady } from '../dev-stack/budget-fixture.ts';
import { assertBelowRecordedSpending, assertChargedTurn, assertRefusedRequestCount,
  budgetChargeSettled } from '../dev-stack/charged-budget-journey.ts';

function checksProjectionProgress(): void {
  assert.equal(budgetChangeIsReady({ content: 'current', iam: 'current' }), true);
  assert.equal(budgetChangeIsReady({ content: 'pending', iam: 'current' }), false);
  assert.equal(budgetChangeIsReady({ content: 'current', iam: 'pending' }), false);
}

test('budget setup waits for both the saved content and access updates', checksProjectionProgress);

function checksAssistantAvailability(): void {
  const ready = { assistantId: 'requested', status: 'ready', canStartSession: true };
  const another = { ...ready, assistantId: 'another' };
  const pending = { ...ready, status: 'pending' };
  const forbidden = { ...ready, canStartSession: false };
  assert.equal(budgetAssistantIsReady(ready, ready.assistantId), true);
  assert.equal(budgetAssistantIsReady(another, ready.assistantId), false);
  assert.equal(budgetAssistantIsReady(pending, ready.assistantId), false);
  assert.equal(budgetAssistantIsReady(forbidden, ready.assistantId), false);
}

test('budget setup requires the requested ready assistant and session access',
  checksAssistantAvailability);

function checksSettledSpending(): void {
  assert.equal(budgetChargeSettled({ monthCents: 2, reservedCents: 0 }, 1), true);
  assert.equal(budgetChargeSettled({ monthCents: 1, reservedCents: 0 }, 1), false);
  assert.equal(budgetChargeSettled({ monthCents: 2, reservedCents: 16 }, 1), false);
}

test('Spending must increase and clear the reservation before the journey moves on',
  checksSettledSpending);

const charge = { reservedCents: 16, chargedCents: 1, spentCents: 2, previousCents: 1,
  requestsBefore: 5, requestsAfterReply: 6 };

function acceptsExpectedTurn(): void {
  assertChargedTurn(charge);
}

test('accepts the stand-in tariff, spending increase and one arrival', acceptsExpectedTurn);

const contradictions = [
  { observation: { ...charge, reservedCents: 0 },
    reason: /reserve 16 cents/u, label: 'zero reservation' },
  { observation: { ...charge, chargedCents: 0, spentCents: 1 },
    reason: /charge 1 cent/u, label: 'zero charge' },
  { observation: { ...charge, reservedCents: 15 },
    reason: /reserve 16 cents/u, label: 'wrong reservation' },
  { observation: { ...charge, chargedCents: 2, spentCents: 3 },
    reason: /charge 1 cent/u, label: 'wrong charge' },
  { observation: { ...charge, spentCents: 3 },
    reason: /Spending shows this turn/u, label: 'wrong spending increase' },
  { observation: { ...charge, requestsAfterReply: 7 },
    reason: /One member call/u, label: 'two provider arrivals' },
];
for (const { observation, reason, label } of contradictions) {
  function refusesContradiction(): void {
    const check = assertChargedTurn.bind(undefined, observation);
    assert.throws(check, reason);
  }
  test(`refuses a charge observation with ${label}`, refusesContradiction);
}

function refusesIncorrectCeilingAndCount(): void {
  assertBelowRecordedSpending(2, 1);
  const equalCeiling = assertBelowRecordedSpending.bind(undefined, 2, 2);
  assert.throws(equalCeiling, /below recorded spending/u);
  assertRefusedRequestCount(6, 6);
  const raisedCount = assertRefusedRequestCount.bind(undefined, 7, 6);
  assert.throws(raisedCount, /refused call did not reach the stand-in/u);
}

test('the saved ceiling must be lower than spending and refusal must keep the arrival count',
  refusesIncorrectCeilingAndCount);
