import { afterEach, beforeEach, expect, it } from 'vitest';
import { natsFixture } from '@opencrane/event-store/testing';
import { BudgetActor, history, priceTableId } from '../src/index.ts';

let nats: Awaited<ReturnType<typeof natsFixture>>;
let actor: BudgetActor;
let clock: Date;
const remedy = '; ask an Owner or Admin or wait for the next UTC budget period';

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

const limits = [
  { scope: 'global', kind: 'monthly', label: 'Silo spending cap reached (monthly)' },
  { scope: 'global', kind: 'daily', label: 'Silo spending cap reached (daily)' },
  { scope: 'paying_group', kind: 'monthly', label: 'Paying group spending cap reached' },
  { scope: 'assistant', kind: 'monthly', label: 'Assistant spending cap reached' },
] as const;
type Limit = (typeof limits)[number];

async function configure(limit: Limit, ceilingCents: number) {
  if (limit.scope === 'global') {
    const settings = limit.kind === 'daily'
      ? { ceilingCents: actor.state.ceilingCents, dailyCeilingCents: ceilingCents }
      : { ceilingCents };
    await actor.configure({ scope: 'global', ...settings, setBy: 'alice' });
    return;
  }
  const scopeId = limit.scope === 'paying_group' ? 'group' : 'assistant';
  await actor.configure({ scope: limit.scope, scopeId, ceilingCents, setBy: 'alice' });
}

async function keepsSpecificReason(limit: Limit) {
  await configure(limit, 1);
  const expectedMessage = limit.label + remedy;
  await expect(actor.reserve(call('refused'), 2)).rejects.toThrow(expectedMessage);
  const stop = actor.state.stops[0]!;
  expect(stop.reasons).toHaveLength(1);
  expect(stop.reasons[0]).toMatchObject({ scope: limit.scope, kind: limit.kind,
    reason: 'bound_refused', ceilingCents: 1, attemptedBoundCents: 2 });
  await expect(actor.reserve(call('later'), 1)).rejects.toThrow(expectedMessage);
  const rows = await history(nats.store, 'budget-test', 'test');
  expect(rows.at(-1)?.event.data).toEqual({ stopId: stop.id,
    work: { conversationId: 'conversation', turnId: 'later' } });

  await configure(limit, 100);
  clock = new Date('2026-11-01T00:00:00Z');
  actor = new BudgetActor(nats.store, 'test', now);
  await actor.start();
  expect(actor.state.stops[0]).toEqual(stop);
  await expect(actor.reserve(call('refused'), 1)).rejects.toThrow(expectedMessage);
  await expect(actor.reserve(call('later'), 1)).rejects.toThrow(expectedMessage);
  await expect(actor.reserve(call('fresh'), 1)).resolves.toBeTypeOf('string');
}

it.each(limits)('keeps the $scope $kind cap in the reply and saved reason after replay',
  keepsSpecificReason);

async function namesConfigurationStop(limit: Limit) {
  await configure(limit, 0);
  await expect(actor.reserve(call('refused'), 1)).rejects.toThrow(limit.label + remedy);
  expect(actor.state.stops[0]?.reasons).toEqual([
    expect.objectContaining({ scope: limit.scope, kind: limit.kind, reason: 'zero_ceiling' }),
  ]);
}

it.each(limits)('names the $scope $kind cap when its zero ceiling refuses a turn',
  namesConfigurationStop);

async function namesOnlyApplicableReasons() {
  for (const limit of limits) {
    await configure(limit, 1);
  }
  const allReasons = 'Silo spending cap reached (monthly); Silo spending cap reached (daily); ' +
    'Paying group spending cap reached; Assistant spending cap reached' + remedy;
  await expect(actor.reserve(call('refused'), 2)).rejects.toThrow(allReasons);
  expect(actor.state.stops[0]?.reasons).toHaveLength(4);

  const siloReasons = 'Silo spending cap reached (monthly); ' +
    'Silo spending cap reached (daily)' + remedy;
  const otherCall = call('other', 'other-group', 'other-assistant');
  await expect(actor.reserve(otherCall, 1)).rejects.toThrow(siloReasons);
  for (const limit of limits) {
    await configure(limit, 100);
  }
  actor = new BudgetActor(nats.store, 'test', now);
  await actor.start();
  await expect(actor.reserve(otherCall, 1)).rejects.toThrow(siloReasons);
  await expect(actor.reserve(call('refused'), 1)).rejects.toThrow(allReasons);
}

it('names several caps only when the saved stop reasons apply to that work',
  namesOnlyApplicableReasons);
