import { expect, it, vi } from 'vitest';
import * as activity from '../src/decision-activity.ts';
import { fixture } from './fixture.ts';

type Setup = Awaited<ReturnType<typeof fixture>>;
const choice = { providerId: 'primary', bindingSequence: 42, model: 'gpt-6-luna' };
const recordedTurn = {
  assistantId: 'assistant', computerId: 'computer', conversationId: 'conversation',
  turnId: 'bound', threadId: 'thread', requesterId: 'alice', task: 'chat_turn',
  payingGroupId: 'personal-default', ...choice,
};
const refusedError = { error: 'Request refused or decision service unavailable' };

async function authorise(setup: Setup, claims: Record<string, unknown>) {
  const token = await setup.sign(claims, 'decision-service');
  const headers = { ...setup.headers, 'x-turn-token': token };
  const body = { model: 'gpt-6-luna', stream: true, input: 'OK', max_output_tokens: 128 };
  const request = { method: 'POST', headers, body: JSON.stringify(body) };
  const response = await fetch(`${setup.options.decisionUrl}/authorize`, request);
  return { response, headers };
}

function expectNoSpend(setup: Setup) {
  expect(setup.actor.state.reservations).toHaveLength(0);
  expect(setup.received()).toBe(0);
}

async function refusesOmittedProviderClaims() {
  const setup = await fixture();
  try {
    await setup.append('computer-assistant', 'computer.turn_started', recordedTurn);
    const claims = { ...setup.t, turn: 'bound' };
    const result = await authorise(setup, claims);
    expect(result.response.status).toBe(403);
    expect(await result.response.json()).toMatchObject(refusedError);
    const gateway = await setup.call(result.headers);
    expect(gateway.status).toBe(403);
    expectNoSpend(setup);
  } finally {
    await setup.close();
  }
}
it('refuses a signed token missing BOTH provider claims for a bound turn',
  refusesOmittedProviderClaims);

const mismatches = [
  { providerId: 'secondary' },
  { bindingSequence: 43 },
  { model: 'gpt-6.1-sol' },
];
async function refusesChangedRecordedChoice(patch: Record<string, unknown>) {
  const setup = await fixture();
  try {
    await setup.append('computer-assistant', 'computer.turn_started', recordedTurn);
    const claims = { ...setup.t, ...choice, turn: 'bound', ...patch };
    const result = await authorise(setup, claims);
    expect(result.response.status).toBe(403);
    // Check the turn refusal itself; the later managed-call refusal could hide a missing check.
    expect(await result.response.json()).toMatchObject(refusedError);
    expectNoSpend(setup);
  } finally {
    await setup.close();
  }
}
it.each(mismatches)('refuses a changed recorded choice %j before the managed-call check',
  refusesChangedRecordedChoice);

const malformedClaims = [
  { providerId: 'primary' },
  { bindingSequence: 42 },
  { ...choice, providerId: 'bad/provider' },
  { ...choice, providerId: 'x'.repeat(201) },
  { ...choice, bindingSequence: 0 },
  { ...choice, bindingSequence: 1.5 },
  { ...choice, bindingSequence: Number.MAX_SAFE_INTEGER + 1 },
];
async function refusesMalformedClaimsBeforeActivity(patch: Record<string, unknown>) {
  const setup = await fixture();
  const reads = vi.spyOn(activity, 'decisionActivity');
  try {
    const claims = { ...setup.t, ...patch };
    const result = await authorise(setup, claims);
    expect(result.response.status).toBe(403);
    expect(await result.response.json()).toMatchObject(refusedError);
    // Stop malformed claims before checking turn activity, which has its own checks.
    expect(reads).not.toHaveBeenCalled();
    expectNoSpend(setup);
  } finally {
    reads.mockRestore();
    await setup.close();
  }
}
it.each(malformedClaims)('refuses malformed provider claims %j before checking turn activity',
  refusesMalformedClaimsBeforeActivity);

async function refusesChangedTaskAtIssuance() {
  const setup = await fixture();
  try {
    await setup.append('computer-assistant', 'computer.turn_started', recordedTurn);
    const input = {
      assistantId: 'assistant', conversationId: 'conversation', turnId: 'bound',
      requesterId: 'alice', threadId: 'thread', task: 'deep_analysis', ...choice,
    };
    await expect(setup.credentials.turn(input)).rejects.toThrow(
      'Recorded turn provider choice mismatch');
    expectNoSpend(setup);
  } finally {
    await setup.close();
  }
}
it('refuses issuance when only the recorded task differs', refusesChangedTaskAtIssuance);
