import { expect, it, vi } from 'vitest';
import { getEventDefinition, computerTurnStartedDataSchema, parseEventByType } from '@opencrane/events';
import { BudgetActor, envelope, history } from '../src/actor.ts';
import { priceTableId } from '../src/state.ts';
import { managedProviderCallsEnabled } from '../src/provider-turns.ts';
import { fixture } from './fixture.ts';

const budgetReservedDataSchema = getEventDefinition('budget.reserved')!.dataSchema;
const choice = { providerId: 'primary', bindingSequence: 42 };
const call = {
  model: 'gpt-6-luna', priceTableId, computerId: 'computer', assistantId: 'assistant',
  requesterId: 'alice', conversationId: 'conversation', turnId: 'turn', threadId: 'thread',
  payingGroupId: 'personal-default', contextDigest: 'a'.repeat(64),
};
const turn = {
  assistantId: 'assistant', computerId: 'computer', conversationId: 'conversation',
  turnId: 'turn', threadId: 'thread', requesterId: 'alice', task: 'chat_turn',
};
const reservation = {
  reservationId: 'reservation', permitId: 'permit', amountCents: 12,
  payingGroupId: 'personal-default', assistantId: 'assistant', modelCall: call,
};

async function replaysProviderReservation() {
  const setup = await fixture();
  try {
    const boundCall = { ...call, ...choice };
    const permit = await setup.actor.reserve(boundCall, 12);
    const rows = await history(setup.nats.store, 'budget-test', 'test');
    function isReservation(row: (typeof rows)[number]) {
      return row.event.type === 'budget.reserved';
    }
    const saved = rows.findLast(isReservation);
    expect(saved?.event.data).toMatchObject({ modelCall: boundCall });
    const replay = new BudgetActor(setup.nats.store, 'test');
    await replay.start();
    expect(replay.state.reservations).toEqual(setup.actor.state.reservations);
    await replay.releaseUndispatched(permit);
    const settled = replay.state.reservations.find(matchesPermit);
    function matchesPermit(row: (typeof replay.state.reservations)[number]) {
      return row.id === permit;
    }
    expect(settled).toMatchObject({ call: boundCall, settledCents: 0 });
  } finally {
    await setup.close();
  }
}
it('saves and replays provider identity without changing the held cents or tariff',
  replaysProviderReservation);

async function refusesManagedTokenOnStaticRoute(claims: Record<string, unknown>) {
  const setup = await fixture();
  try {
    const token = await setup.sign({ ...setup.t, ...claims }, 'decision-service');
    const headers = { 'x-turn-token': token };
    const before = setup.actor.state.reservations.length;
    const requestsBefore = setup.received();
    const response = await setup.call(headers);
    expect(response.status).toBe(403);
    expect(setup.received()).toBe(requestsBefore);
    expect(setup.actor.state.reservations).toHaveLength(before);
  } finally {
    await setup.close();
  }
}
const refusedClaims = [choice, { providerId: 'primary' }, { bindingSequence: 42 },
  { ...choice, bindingSequence: 0 }, { ...choice, bindingSequence: 1.5 },
  { ...choice, providerId: 'foreign' }];
it.each(refusedClaims)('refuses provider claims %j before static-key dispatch or reservation',
  refusesManagedTokenOnStaticRoute);

async function keepsLegacyTraffic() {
  const setup = await fixture();
  try {
    expect((await setup.call()).status).toBe(200);
    await setup.settled();
    expect(setup.received()).toBe(1);
    expect(setup.actor.state.reservations[0]?.call).not.toHaveProperty('providerId');
  } finally {
    await setup.close();
  }
}
it('keeps existing tokens and reservations working on the deployment-key route',
  keepsLegacyTraffic);

function checksStoredShapes() {
  expect(budgetReservedDataSchema.safeParse(reservation).success).toBe(true);
  const bound = { ...reservation, modelCall: { ...call, ...choice } };
  expect(budgetReservedDataSchema.safeParse(bound).success).toBe(true);
  const incomplete = { ...reservation, modelCall: { ...call, providerId: 'primary' } };
  expect(budgetReservedDataSchema.safeParse(incomplete).success).toBe(false);
  expect(computerTurnStartedDataSchema.safeParse(turn).success).toBe(true);
  const boundTurn = { ...turn, ...choice, model: 'gpt-6-luna' };
  expect(computerTurnStartedDataSchema.safeParse(boundTurn).success).toBe(true);
  const incompleteTurn = { ...turn, providerId: 'primary', model: 'gpt-6-luna' };
  expect(computerTurnStartedDataSchema.safeParse(incompleteTurn).success).toBe(false);
}
it('reads old stored shapes and requires complete provider fields on new records', checksStoredShapes);

async function checksIssuedChoiceAgainstTurn() {
  const setup = await fixture();
  try {
    const recorded = { ...turn, ...choice, model: call.model, turnId: 'bound',
      payingGroupId: call.payingGroupId };
    await setup.append('computer-assistant', 'computer.turn_started', recorded);
    const input = { assistantId: turn.assistantId, conversationId: turn.conversationId,
      turnId: 'bound', requesterId: turn.requesterId, threadId: turn.threadId,
      task: turn.task, model: call.model, ...choice };
    const issued = await setup.credentials.turn(input);
    const headers = { ...setup.headers, 'x-turn-token': issued.value };
    const checked = await setup.credentials.check(headers);
    expect(checked.turn).toMatchObject({ ...choice, model: call.model });
    const otherModel = { ...input, model: 'gpt-6.1-sol' };
    await expect(setup.credentials.turn(otherModel)).rejects.toThrow();
    const otherProvider = { ...input, providerId: 'secondary' };
    await expect(setup.credentials.turn(otherProvider)).rejects.toThrow();
    const otherPosition = { ...input, bindingSequence: 43 };
    await expect(setup.credentials.turn(otherPosition)).rejects.toThrow();
    const missingChoice = { ...input, providerId: undefined, bindingSequence: undefined };
    await expect(setup.credentials.turn(missingChoice)).rejects.toThrow();
  } finally {
    await setup.close();
  }
}
it('issues only the provider, binding position and model recorded for that turn',
  checksIssuedChoiceAgainstTurn);

async function refusesRecordedChoiceOnStaticRoute() {
  const setup = await fixture();
  try {
    const recorded = { ...turn, ...choice, model: call.model, turnId: 'bound',
      payingGroupId: call.payingGroupId };
    await setup.append('computer-assistant', 'computer.turn_started', recorded);
    const token = await setup.sign({ ...setup.t, ...choice, turn: 'bound' }, 'decision-service');
    const headers = { ...setup.headers, 'x-turn-token': token };
    const body = { model: call.model, stream: true, input: 'OK', max_output_tokens: 128 };
    const request = { method: 'POST', headers, body: JSON.stringify(body) };
    const response = await fetch(`${setup.options.decisionUrl}/authorize`, request);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: 'Managed provider calls are not available yet',
    });
    expect((await setup.call(headers)).status).toBe(403);
    expect(setup.received()).toBe(0);
    expect(setup.actor.state.reservations).toHaveLength(0);
  } finally {
    await setup.close();
  }
}
it('refuses even a matching recorded provider choice on the static-key route without holding money',
  refusesRecordedChoiceOnStaticRoute);

async function refusesLegacyTrafficAfterSwitch() {
  const setup = await fixture();
  try {
    await setup.append('provider-primary', 'provider.created', {
      providerId: 'primary', provider: 'openai', name: 'Primary', revision: 1, changedBy: 'alice',
    });
    await setup.append('budget-test', 'provider.managed_calls_enabled', {
      providerId: 'primary', revision: 1, changedBy: 'alice', expectedProviderSequence: 0,
    });
    expect((await setup.call()).status).toBe(403);
    expect(setup.received()).toBe(0);
    expect(setup.actor.state.reservations).toHaveLength(0);
  } finally {
    await setup.close();
  }
}
it('refuses old tokens after switch-on before holding money or contacting a provider',
  refusesLegacyTrafficAfterSwitch);


async function refusesModeChangeBeforeReservation() {
  const setup = await fixture();
  const reserve = setup.actor.reserve.bind(setup.actor);
  async function switchBeforeReserve(...args: Parameters<typeof reserve>) {
    await setup.append('provider-primary', 'provider.created', {
      providerId: 'primary', provider: 'openai', name: 'Primary', revision: 1, changedBy: 'alice',
    });
    await setup.append('budget-test', 'provider.managed_calls_enabled', {
      providerId: 'primary', revision: 1, changedBy: 'alice', expectedProviderSequence: 0,
    });
    return reserve(...args);
  }
  const reserving = vi.spyOn(setup.actor, 'reserve').mockImplementation(switchBeforeReserve);
  try {
    expect((await setup.call()).status).toBe(403);
    expect(reserving).toHaveBeenCalledOnce();
    expect(setup.received()).toBe(0);
    expect(setup.actor.state.reservations).toHaveLength(0);
  } finally {
    reserving.mockRestore();
    await setup.close();
  }
}
it('refuses switch-on racing the budget queue without holding money',
  refusesModeChangeBeforeReservation);

function requiresSiloSpendingStreamForSwitchOn() {
  const payload = {
    providerId: 'primary', revision: 1, changedBy: 'alice', expectedProviderSequence: 0,
  };
  const switched = envelope('test', 'budget-test', 'provider.managed_calls_enabled', payload);
  expect(getEventDefinition(switched.type)?.stream).toBe('budget');
  expect(parseEventByType(switched).success).toBe(true);
  const providerSubject = { ...switched, subject: 'provider-primary' };
  const otherSilo = { ...switched, subject: 'budget-other' };
  expect(parseEventByType(providerSubject).success).toBe(false);
  expect(parseEventByType(otherSilo).success).toBe(false);
}
it('requires switch-on to use the exact silo spending stream',
  requiresSiloSpendingStreamForSwitchOn);

async function keepsModeAfterBudgetReplay() {
  const setup = await fixture();
  try {
    await setup.append('provider-primary', 'provider.created', {
      providerId: 'primary', provider: 'openai', name: 'Primary', revision: 1, changedBy: 'alice',
    });
    await setup.append('budget-test', 'provider.managed_calls_enabled', {
      providerId: 'primary', revision: 1, changedBy: 'alice', expectedProviderSequence: 0,
    });
    const replay = new BudgetActor(setup.nats.store, 'test');
    await replay.start();
    const enabled = await managedProviderCallsEnabled(setup.nats.store, 'test', Infinity);
    expect(enabled).toBe(true);
    expect(replay.state.reservations).toHaveLength(0);
    const reads = vi.spyOn(setup.nats.store, 'readStream');
    try {
      expect((await setup.call()).status).toBe(403);
      function readsProviderCategory(args: Parameters<typeof setup.nats.store.readStream>) {
        return args[0].includes('*');
      }
      expect(reads.mock.calls.some(readsProviderCategory)).toBe(false);
    } finally {
      reads.mockRestore();
    }
    expect(setup.received()).toBe(0);
    expect(setup.actor.state.reservations).toHaveLength(0);
  } finally {
    await setup.close();
  }
}
it('keeps switch-on after spending replay without scanning provider connections',
  keepsModeAfterBudgetReplay);
