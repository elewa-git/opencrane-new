import { expect, it } from 'vitest';
import { z } from 'zod';
import { tokenVerifier } from '@opencrane/auth';
import { createEventStore } from '@opencrane/event-store';
import { BudgetActor, admitDescendant, descendantId, envelope, history, priceTableId,
  startDecision } from '../src/index.ts';
import { reserveNativeCall } from '../src/native-call-check.ts';
import { parseTurnToken } from '../src/decision-turn-token.ts';
import { rootTotals } from '../src/root-budget.ts';
import { fixture } from './fixture.ts';

type Context = Awaited<ReturnType<typeof setup>>;
const start = { assistantId: 'assistant', computerId: 'computer', conversationId: 'conversation',
  turnId: 'native-root', threadId: 'native-thread', requesterId: 'alice', task: 'chat_turn',
  payingGroupId: 'personal-default', executionMode: 'memory_free', model: 'gpt-6.1-sol',
  providerId: 'provider', bindingSequence: 1 };
const allowance = { requesterId: 'alice', conversationId: 'conversation', turnId: start.turnId,
  threadId: start.threadId, assistantId: 'assistant', computerId: 'computer', generation: 1,
  payingGroupId: 'personal-default', allowanceCents: 1000 };
const rootCall = { requesterId: 'alice', conversationId: 'conversation', turnId: start.turnId,
  threadId: start.threadId, assistantId: 'assistant', computerId: 'computer', generation: 1,
  payingGroupId: 'personal-default', model: start.model, priceTableId,
  contextDigest: '0'.repeat(64) };
async function setup() {
  const context = await fixture(10_000, 20_000, false, start.model);
  await context.append('computer-assistant', 'computer.turn_started', start);
  const root = await context.actor.setRootAllowance(allowance, 1);
  const store = await createEventStore(await context.nats.client('command'));
  const replica = await startDecision(context.actor, context.identity, context.binding);
  return { ...context, root, store, replica };
}
async function close(context: Context) {
  await context.replica.close();
  await context.close();
}
function child(context: Context, name: string) {
  const scopes = { models: [start.model], tools: [], resources: [], operations: [],
    destinations: [], connectionIds: [], profileIds: [] };
  const binding = { ...start, task: 'native_descendant', generation: 1, dataClass: 'private',
    rootId: context.root.rootId, rootTurnId: start.turnId, rootThreadId: start.threadId,
    parentTurnId: start.turnId, parentThreadId: start.threadId, delegationId: '', scopes,
    turnId: `turn-${name}`, threadId: `thread-${name}`, spawnItemId: `spawn-${name}` };
  binding.delegationId = descendantId('test', binding);
  return binding;
}
async function admit(context: Context, binding: ReturnType<typeof child>, ttl = 120) {
  binding.delegationId = descendantId('test', binding);
  const claims = { typ: 'descendant-admission', silo: 'test', jti: binding.delegationId, binding };
  const decision = await context.sign(claims, 'delegation-admission', ttl);
  const verifier = tokenVerifier(context.identity.jwks, context.identity.issuer);
  return admitDescendant(context.store, context.binding, verifier, decision);
}
function claims(context: Context, binding: ReturnType<typeof child>) {
  return { ...context.t, task: binding.task, turn: binding.turnId, thread: binding.threadId,
    providerId: binding.providerId, bindingSequence: binding.bindingSequence,
    delegation: ['alice', binding.delegationId], iat: 1, exp: 121 };
}
async function reserve(context: Context, binding: ReturnType<typeof child>, cents: number,
  store = context.nats.store, actor = context.actor) {
  const checked = await context.credentials.check(context.headers);
  const turn = parseTurnToken(claims(context, binding));
  const computer = { assistant: 'assistant', computer: 'computer', generation: 1 };
  const started = performance.now();
  return reserveNativeCall(actor, store, context.binding, computer, turn,
    checked.sequence, started, started + 2000, cents);
}
async function refusedRoute(context: Context, binding: ReturnType<typeof child>, url: string,
  expected: string) {
  const token = await context.sign(claims(context, binding), 'decision-service');
  const headers = { ...context.headers, 'x-turn-token': token, 'session-id': binding.threadId };
  const options = { method: 'POST', headers, body: 'not json' };
  const response = await fetch(`${url}/authorize`, options);
  expect(response.status).toBe(403);
  const result = z.object({ error: z.string(), requestId: z.string() }).parse(await response.json());
  expect(result.error).toBe(expected);
  const audit = await history(context.store, `decision-${result.requestId}`, 'test');
  expect(audit[0]?.event.data).toMatchObject({ outcome: 'deny' });
}
async function settle(context: Context, id: string, cents: number) {
  const evidence = [{ kind: 'provider_receipt', reference: 'receipt',
    digest: '0'.repeat(64), amountCents: cents }];
  const data = { reservationId: id, permitId: id, settledCents: cents, outcome: 'settled',
    resolvedBy: 'owner', evidence };
  const saved = envelope('test', `effect-${id}`, 'effect.resolved', data);
  const event = { ...saved, principal: { kind: 'human' as const, id: 'owner' } };
  await context.actor.settle(event);
}
async function refusesRoot(change: string) {
  const context = await setup();
  try {
    const binding = child(context, 'refused');
    if (change === 'missing') binding.rootId = 'missing';
    if (change === 'foreign') {
      const foreign = { ...allowance, turnId: 'foreign', threadId: 'foreign',
        payingGroupId: 'another-group' };
      binding.rootId = (await context.actor.setRootAllowance(foreign, 1)).rootId;
    }
    if (change === 'generation') binding.generation = 2;
    if (change === 'ended') {
      await context.append('computer-assistant', 'computer.turn_closed',
        { ...start, status: 'completed' });
    }
    const position = await context.nats.store.head();
    const ttl = change === 'stale' ? -1 : 120;
    await expect(admit(context, binding, ttl)).rejects.toThrow();
    expect(await context.nats.store.head()).toBe(position);
    expect(context.actor.state.reservations).toHaveLength(0);
    expect(context.received()).toBe(0);
  } finally {
    await close(context);
  }
}
it.each(['missing', 'foreign', 'generation', 'ended', 'stale'])(
  'refuses a %s root binding before saving a descendant', refusesRoot);

async function racesCapacity() {
  const context = await setup();
  try {
    const first = child(context, 'first');
    const second = child(context, 'second');
    await admit(context, first);
    await admit(context, second);
    const settled = await context.actor.reserve(rootCall, 240, undefined, undefined,
      context.root.rootId);
    await settle(context, settled, 240);
    await context.actor.reserve(rootCall, 110, undefined, undefined, context.root.rootId);
    expect(rootTotals(context.actor.state, context.root.rootId)).toEqual({
      settledCents: 240, heldCents: 110, availableCents: 650 });
    await Promise.all([
      refusedRoute(context, first, context.options.decisionUrl, 'Native delegation is disabled'),
      refusedRoute(context, second, context.replica.url, 'Native delegation is disabled'),
    ]);
    // Exercise the internal hold operation; both HTTP services must remain disabled.
    const results = await Promise.allSettled([
      reserve(context, first, 400), reserve(context, second, 300, context.store),
    ]);
    function succeeded(result: PromiseSettledResult<string>) {
      return result.status === 'fulfilled';
    }
    expect(results.filter(succeeded)).toHaveLength(1);
    expect(context.root.stop?.reason).toBe('allowance_exhausted');
    expect(context.actor.state.reservations).toHaveLength(3);
    const held = context.actor.state.reservations[2]!;
    expect([first.turnId, second.turnId]).toContain(held.call.turnId);
    expect(held.rootId).toBe(context.root.rootId);
    expect(held.call.payingGroupId).toBe(allowance.payingGroupId);
    const totals = rootTotals(context.actor.state, context.root.rootId);
    expect(totals.heldCents).toBeLessThanOrEqual(650);
    const otherBinding = { ...allowance, turnId: 'other', threadId: 'other' };
    const other = await context.actor.setRootAllowance(otherBinding, 1);
    const otherCall = { ...rootCall, turnId: 'other', threadId: 'other' };
    await context.actor.reserve(otherCall, 1, undefined, undefined, other.rootId);
    const recovered = new BudgetActor(context.store, 'test', context.actor.now);
    await recovered.start();
    expect(rootTotals(recovered.state, context.root.rootId)).toEqual(totals);
    await expect(reserve(context, first, 1, context.store, recovered)).rejects.toThrow();
    expect(rootTotals(recovered.state, context.root.rootId)).toEqual(totals);
    expect(recovered.state.dispatches).toHaveLength(0);
    expect(context.received()).toBe(0);
  } finally {
    await close(context);
  }
}
it('shares 650 remaining cents across replicas, stops only that root and replays the stop',
  racesCapacity);

async function settlesOnce() {
  const context = await setup();
  try {
    const first = child(context, 'first');
    const second = child(context, 'second');
    await admit(context, first);
    await admit(context, second);
    const firstHold = await reserve(context, first, 300);
    const secondHold = await reserve(context, second, 200, context.store);
    await settle(context, firstHold, 180);
    await settle(context, secondHold, 120);
    await settle(context, secondHold, 120);
    expect(rootTotals(context.actor.state, context.root.rootId)).toEqual({
      settledCents: 300, heldCents: 0, availableCents: 700 });
    const unsent = await reserve(context, first, 90);
    const unknown = await reserve(context, second, 110);
    await context.actor.uncertain(unknown, 'settle_timeout');
    await context.actor.releaseUndispatched(unsent);
    await expect(context.actor.releaseUndispatched(unknown)).rejects.toThrow();
    expect(rootTotals(context.actor.state, context.root.rootId)).toEqual({
      settledCents: 300, heldCents: 110, availableCents: 590 });
    const recovered = new BudgetActor(context.store, 'test', context.actor.now);
    await recovered.start();
    expect(rootTotals(recovered.state, context.root.rootId)).toEqual({
      settledCents: 300, heldCents: 110, availableCents: 590 });
    expect(recovered.state.dispatches).toHaveLength(0);
    expect(context.received()).toBe(0);
  } finally {
    await close(context);
  }
}
it('settles child holds once and releases only proven unsent money across replay', settlesOnce);
