import { expect, it, vi } from 'vitest';
import { request, IncomingMessage } from 'node:http';
import { once } from 'node:events';
import { z } from 'zod';
import { tokenVerifier } from '@opencrane/auth';
import { grantStream } from '@opencrane/authz';
import { createEventStore } from '@opencrane/event-store';
import { BudgetActor, admitDescendant, descendantId, envelope, history, priceTableId,
  startDecision, requestReservationCents } from '../src/index.ts';
import { reserveNativeCall } from '../src/native-call-check.ts';
import { grantModelCall } from '../src/call-retry.ts';
import { parseTurnToken } from '../src/decision-turn-token.ts';
import { rootTotals } from '../src/root-budget.ts';
import { fixture } from './fixture.ts';

type Context = Awaited<ReturnType<typeof setup>>;
const start = { assistantId: 'assistant', computerId: 'computer', conversationId: 'conversation',
  turnId: 'native-root', threadId: 'native-thread', requesterId: 'alice', task: 'chat_turn',
  payingGroupId: 'personal-default', executionMode: 'memory_free', model: 'gpt-5.5-pro',
  providerId: 'provider', bindingSequence: 1 };
const allowance = { requesterId: 'alice', conversationId: 'conversation', turnId: start.turnId,
  threadId: start.threadId, assistantId: 'assistant', computerId: 'computer', generation: 1,
  payingGroupId: 'personal-default', allowanceCents: 1000 };
const rootCall = { requesterId: 'alice', conversationId: 'conversation', turnId: start.turnId,
  threadId: start.threadId, assistantId: 'assistant', computerId: 'computer', generation: 1,
  payingGroupId: 'personal-default', model: start.model, priceTableId,
  contextDigest: '0'.repeat(64) };
const body = { model: start.model, stream: true, input: 'hello', max_output_tokens: 16 };
function bodyForCents(cents: number) {
  let low = 0;
  let high = 1_000_000;
  while (low <= high) {
    const size = Math.floor((low + high) / 2);
    const candidate = { ...body, input: 'x'.repeat(size) };
    const cost = requestReservationCents(candidate);
    if (cost === cents) return candidate;
    if (cost < cents) low = size + 1;
    else high = size - 1;
  }
  throw new Error('Fixture cost unavailable');
}
async function setup(rootPatch: Record<string, unknown> = {}) {
  const context = await fixture(10_000, 20_000, false, start.model);
  await context.append('computer-assistant', 'computer.turn_started', start);
  const rootBinding = { ...allowance, ...rootPatch };
  const root = await context.actor.setRootAllowance(rootBinding, 1);
  const store = await createEventStore(await context.nats.client('command'));
  const replica = await startDecision(context.actor, context.identity, context.binding);
  return Object.assign(context, { root, store, replica });
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
async function reserve(context: Context, binding: ReturnType<typeof child>, cents: number | string,
  store = context.nats.store, actor = context.actor) {
  let held: string | undefined;
  function pauseBeforeDecision(reservationId: string): Promise<string> {
    held = reservationId;
    throw new Error('Decision not yet saved');
  }
  try {
    await nativeGrant(context, binding, cents, `call-${binding.turnId}-${cents}`,
      pauseBeforeDecision, store, actor);
    throw new Error('Dispatch must wait for a decision');
  } catch (error) {
    if (held === undefined) throw error;
    expect(error).toMatchObject({ message: 'Model call retry refused' });
    return held;
  }
}
async function nativeGrant(context: Context, binding: ReturnType<typeof child>,
  cents: number | string, callId: string,
  allow: (reservationId: string, requestId: string) => Promise<string>,
  store = context.nats.store, actor = context.actor) {
  const raw = typeof cents === 'string' ? cents : JSON.stringify(bodyForCents(cents));
  const checked = await context.credentials.check(context.headers);
  const turn = parseTurnToken(claims(context, binding));
  const computer = { assistant: 'assistant', computer: 'computer', generation: 1 };
  const started = performance.now();
  return reserveNativeCall(actor, store, context.binding, computer, turn,
    checked.sequence, started, started + 10_000, raw, callId, allow);
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
  await context.nats.seed([event]);
  await context.actor.settleRecorded(id, event.id);
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
    if (change === 'caller budget') {
      const suppliedBudget = { allowanceCents: 9000 };
      Object.assign(binding, suppliedBudget);
    }
    if (change === 'payer') binding.payingGroupId = 'another-group';
    if (change === 'ended') {
      const closed = { ...start, status: 'completed' };
      await context.append('computer-assistant', 'computer.turn_closed', closed);
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
it.each(['missing', 'foreign', 'generation', 'ended', 'stale', 'caller budget', 'payer'])(
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
    expect(context.actor.state.reservations).toHaveLength(2);
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
    expect(held.call).toMatchObject({ payingGroupId: allowance.payingGroupId,
      providerId: start.providerId, bindingSequence: start.bindingSequence });
    await refusedRoute(context, second, context.replica.url,
      'Request refused or decision service unavailable');
    const input = { assistantId: 'assistant', conversationId: 'conversation',
      turnId: first.turnId, threadId: first.threadId, requesterId: 'alice',
      task: 'native_descendant', model: start.model };
    await expect(context.credentials.turn(input)).rejects.toThrow('Native delegation is disabled');
    const totals = rootTotals(context.actor.state, context.root.rootId);
    expect([410, 510]).toContain(totals.heldCents);
    const otherBinding = { ...allowance, turnId: 'other', threadId: 'other' };
    const other = await context.actor.setRootAllowance(otherBinding, 1);
    const otherCall = { ...rootCall, turnId: 'other', threadId: 'other' };
    await context.actor.reserve(otherCall, 1, undefined, undefined, other.rootId);
    const recovered = new BudgetActor(context.store, 'test', context.actor.now);
    await recovered.start();
    expect(rootTotals(recovered.state, context.root.rootId)).toEqual(totals);
    await expect(reserve(context, first, 10, context.store, recovered)).rejects.toThrow();
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

async function refusesOverrunOrRevocation(change: string) {
  const context = await setup();
  try {
    const binding = child(context, 'guarded');
    await admit(context, binding);
    const settled = await context.actor.reserve(rootCall, 240, undefined, undefined,
      context.root.rootId);
    await settle(context, settled, 240);
    await context.actor.reserve(rootCall, 110, undefined, undefined, context.root.rootId);
    if (change === 'revocation') {
      const revoke = { resourceType: 'model', resourceId: start.model,
        granteeKind: 'member', granteeId: 'alice', revokedBy: 'alice' };
      await context.append(grantStream('model', start.model), 'grant.revoked', revoke);
      expect((await context.auth.use('person', 'alice', 'model', start.model)).allowed).toBe(true);
    }
    const position = await context.nats.store.head('budget-test');
    await expect(reserve(context, binding, 651)).rejects.toThrow();
    expect(context.actor.state.reservations).toHaveLength(2);
    expect(context.actor.state.dispatches).toHaveLength(0);
    expect(rootTotals(context.actor.state, context.root.rootId)).toEqual({
      settledCents: 240, heldCents: 110, availableCents: 650 });
    if (change === 'revocation') {
      expect(await context.nats.store.head('budget-test')).toBe(position);
      expect(context.root.stop).toBeUndefined();
    } else {
      const rows = await history(context.store, 'budget-test', 'test');
      expect(rows.at(-1)?.event).toMatchObject({ type: 'budget.root_stopped',
        data: { reason: 'allowance_exhausted', attemptedBoundCents: 651, availableCents: 650 } });
    }
    expect(context.received()).toBe(0);
  } finally {
    await close(context);
  }
}
it.each(['overrun', 'revocation'])(
  'refuses %s before a child hold or dispatch despite stale IAM', refusesOverrunOrRevocation);

async function refusesSavedAllowance(field: string, value: string | number) {
  const patch = { [field]: value };
  const context = await setup(patch);
  try {
    const binding = child(context, 'mismatch');
    const position = await context.nats.store.head();
    await expect(admit(context, binding)).rejects.toThrow(/^Descendant allowance refused$/u);
    expect(await context.nats.store.head()).toBe(position);
    expect(context.actor.state.reservations).toHaveLength(0);
    expect(context.received()).toBe(0);
  } finally {
    await close(context);
  }
}
it.each([
  ['requesterId', 'bob'], ['payingGroupId', 'foreign'], ['conversationId', 'foreign'],
  ['turnId', 'foreign'], ['threadId', 'foreign'], ['assistantId', 'foreign'],
  ['computerId', 'foreign'], ['generation', 2],
] as const)('requires the saved allowance %s to match the checked root', refusesSavedAllowance);

async function checksRequestCost() {
  const context = await setup();
  try {
    const binding = child(context, 'cost');
    await admit(context, binding);
    const position = await context.store.head('budget-test');
    const invalid = [{ ...body, model: 'gpt-6-astra' }, { ...body, n: 2 },
      { ...body, max_output_tokens: 15 }, { ...body, max_output_tokens: 2001 },
      { ...body, extra: 'private-value' }];
    for (const requestBody of invalid) {
      await expect(reserve(context, binding, JSON.stringify(requestBody)))
        .rejects.toThrow(/^Descendant request refused$/u);
      expect(await context.store.head('budget-test')).toBe(position);
    }
    await expect(reserve(context, binding, 'private malformed JSON'))
      .rejects.toThrow(/^Descendant request refused$/u);
    expect(await context.store.head('budget-test')).toBe(position);
    const narrow = child(context, 'unscoped');
    narrow.scopes.models = [];
    await admit(context, narrow);
    await expect(reserve(context, narrow, JSON.stringify(body))).rejects.toThrow();
    expect(await context.store.head('budget-test')).toBe(position);
    const id = await reserve(context, binding, JSON.stringify(body));
    expect(context.actor.state.reservations).toMatchObject([
      { id, amountCents: requestReservationCents(body) },
    ]);
  } finally {
    await close(context);
  }
}
it('computes native cost from a strict scoped body before any budget write', checksRequestCost);

const rootTurn = { turnId: start.turnId, threadId: start.threadId };
async function fresh() {}
function dispatch(context: Context, id: string) {
  const hold = context.actor.state.reservations.find(matches);
  function matches(row: Context['actor']['state']['reservations'][number]) {
    return row.id === id;
  }
  return { callId: hold!.call.requestId ?? id, decisionId: id, reservationId: id,
    rootId: context.root.rootId, bodyDigest: hold!.bodyDigest ?? '0'.repeat(64),
    modelCall: hold!.call };
}
async function checksNativeDispatch(change: string) {
  const context = await setup();
  try {
    const binding = child(context, 'dispatch');
    await admit(context, binding);
    const settled = await context.actor.reserve(rootCall, 240, undefined, undefined,
      context.root.rootId);
    await settle(context, settled, 240);
    await context.actor.reserve(rootCall, 110, undefined, undefined, context.root.rootId);
    const id = await reserve(context, binding, 400);
    const input = dispatch(context, id);
    if (change === 'exhaustion') {
      await expect(reserve(context, binding, 300)).rejects.toThrow();
    }
    if (change === 'stop') {
      const stop = { conversationId: 'conversation', turnId: start.turnId, requestedBy: 'alice' };
      await context.append('conversation-conversation', 'agent.turn_stop_requested', stop);
      const position = await context.store.head('conversation-conversation');
      await context.actor.stopRoot(context.root.rootId, 'requester_stop',
        'conversation-conversation', position);
    }
    if (change === 'stop' || change === 'exhaustion') {
      await expect(context.actor.admitDispatch(input, fresh, undefined, rootTurn)).rejects.toThrow();
      expect(rootTotals(context.actor.state, context.root.rootId)).toEqual({
        settledCents: 240, heldCents: 110, availableCents: 650 });
      const rows = await history(context.store, 'budget-test', 'test');
      expect(rows.at(-1)?.event).toMatchObject({ type: 'budget.settled',
        data: { reservationId: id, settledCents: 0, outcome: 'not_dispatched' } });
      expect(context.actor.state.dispatches).toHaveLength(0);
      return;
    }
    const original = context.actor.store.append.bind(context.actor.store);
    async function append(command: Parameters<typeof original>[0]) {
      const result = await original(command);
      const event = z.object({ type: z.string() }).parse(command.event);
      if (event.type === 'budget.call_dispatch_admitted') {
        throw new Error('Lost admission reply');
      }
      return result;
    }
    if (change === 'lost reply') vi.spyOn(context.actor.store, 'append').mockImplementation(append);
    const admitted = context.actor.admitDispatch(input, fresh, undefined, rootTurn);
    if (change === 'lost reply') await expect(admitted).rejects.toThrow('Lost admission reply');
    else await admitted;
    vi.restoreAllMocks();
    const recovered = new BudgetActor(context.store, 'test', context.actor.now);
    await recovered.start();
    await expect(recovered.admitDispatch(input, fresh, undefined, rootTurn)).rejects.toThrow();
    expect(recovered.state.dispatches).toHaveLength(1);
    expect(rootTotals(recovered.state, context.root.rootId).heldCents).toBe(510);
  } finally {
    vi.restoreAllMocks();
    await close(context);
  }
}
it.each(['open', 'lost reply', 'stop', 'exhaustion'])(
  'checks the native root at dispatch: %s', checksNativeDispatch);

async function checksQueuedAccess() {
  const context = await setup({ allowanceCents: 650 });
  const release = Promise.withResolvers<void>();
  try {
    const binding = child(context, 'queued');
    await admit(context, binding);
    const entered = Promise.withResolvers<void>();
    async function holdQueue() {
      entered.resolve();
      await release.promise;
    }
    const blocking = context.actor.reserve(rootCall, 1, holdQueue, undefined, context.root.rootId);
    await entered.promise;
    const queued = Promise.withResolvers<void>();
    const original = context.actor.reserve.bind(context.actor);
    function reserveCall(...args: Parameters<typeof original>) {
      queued.resolve();
      return original(...args);
    }
    vi.spyOn(context.actor, 'reserve').mockImplementation(reserveCall);
    const pending = reserve(context, binding, 651);
    const refused = expect(pending).rejects.toThrow();
    await queued.promise;
    const revoke = { resourceType: 'model', resourceId: start.model,
      granteeKind: 'member', granteeId: 'alice', revokedBy: 'alice' };
    await context.append(grantStream('model', start.model), 'grant.revoked', revoke);
    release.resolve();
    await blocking;
    await refused;
    expect(context.root.stop).toBeUndefined();
    expect(context.actor.state.reservations).toHaveLength(1);
    const childCall = { ...rootCall, turnId: binding.turnId, threadId: binding.threadId };
    await expect(original(childCall, 1, undefined, undefined, context.root.rootId,
      undefined, rootTurn)).rejects.toThrow('Descendant access check required');
  } finally {
    release.resolve();
    vi.restoreAllMocks();
    await close(context);
  }
}
it('requires fresh native access and refuses queued revocation without stopping the root',
  checksQueuedAccess);

async function checksAllowanceRead(stop: boolean) {
  const context = await setup();
  try {
    const binding = child(context, 'allowance');
    const computerPosition = await context.store.head('computer-assistant');
    let checking = false;
    let preloaded = false;
    let grantsLoaded = false;
    const originalRead = context.store.readStream.bind(context.store);
    const originalHead = context.store.head.bind(context.store);
    async function* readStream(...args: Parameters<typeof originalRead>) {
      if (args[0] === 'budget-test') {
        if (checking) expect(args[1]).toBeGreaterThan(1);
        else preloaded = true;
      }
      yield* originalRead(...args);
      if (args[0] === grantStream('model', start.model)) grantsLoaded = true;
    }
    async function head(...args: Parameters<typeof originalHead>) {
      if (args[0] === undefined && grantsLoaded && !checking) {
        checking = true;
        expect(preloaded).toBe(true);
        if (stop) {
          const data = { rootId: context.root.rootId, reason: 'allowance_exhausted',
            attemptedBoundCents: 1001, availableCents: 1000 };
          await context.append('budget-test', 'budget.root_stopped', data);
        }
      }
      return originalHead(...args);
    }
    vi.spyOn(context.store, 'readStream').mockImplementation(readStream);
    vi.spyOn(context.store, 'head').mockImplementation(head);
    const pending = admit(context, binding);
    if (stop) await expect(pending).rejects.toThrow('Descendant allowance refused');
    else await pending;
    expect(checking).toBe(true);
    const rows = await history(context.nats.store, `delegation-${binding.delegationId}`, 'test');
    expect(rows).toHaveLength(stop ? 0 : 1);
    if (stop) {
      expect(await context.store.head('computer-assistant')).toBe(computerPosition);
    }
  } finally {
    vi.restoreAllMocks();
    await close(context);
  }
}
it.each([false, true])('preloads allowance and renews it after another writer stops: %s',
  checksAllowanceRead);

async function refusesWithoutReadingBody() {
  const context = await setup();
  try {
    const binding = child(context, 'route');
    await admit(context, binding);
    const token = await context.sign(claims(context, binding), 'decision-service');
    const raw = JSON.stringify(body);
    const headers = { ...context.headers, 'x-turn-token': token, 'session-id': binding.threadId,
      'content-length': Buffer.byteLength(raw) };
    const options = { method: 'POST', headers };
    const outgoing = request(`${context.options.decisionUrl}/authorize`, options);
    const responseReady = once(outgoing, 'response');
    outgoing.flushHeaders();
    // Wait for refusal before sending any of the declared, valid body.
    const result: unknown[] = await responseReady;
    const response = result[0];
    if (!(response instanceof IncomingMessage)) throw new Error('Unexpected response');
    const chunks: Buffer[] = [];
    for await (const chunk of response) {
      const bytes: unknown = chunk;
      if (!Buffer.isBuffer(bytes)) throw new Error('Unexpected response');
      chunks.push(bytes);
    }
    outgoing.end(raw);
    expect(response.statusCode).toBe(403);
    expect(JSON.parse(Buffer.concat(chunks).toString())).toMatchObject({
      error: 'Native delegation is disabled' });
    expect(context.actor.state.reservations).toHaveLength(0);
  } finally {
    await close(context);
  }
}
it('refuses a valid native route before reading any body bytes', refusesWithoutReadingBody);

async function recoversNativeRootTurn() {
  const context = await setup();
  try {
    const binding = child(context, 'retry');
    await admit(context, binding);
    const call = { ...rootCall, requestId: 'original', contextDigest: binding.delegationId,
      turnId: binding.turnId, threadId: binding.threadId };
    const retry = { retryDigest: '1'.repeat(64), bodyDigest: '2'.repeat(64) };
    const id = await context.actor.reserve(call, 1, fresh, undefined,
      context.root.rootId, retry, rootTurn);
    const again = { ...call, requestId: 'replacement' };
    expect(await context.actor.reserve(again, 1, fresh, undefined,
      context.root.rootId, retry, rootTurn)).toBe(id);
    expect(context.actor.state.reservations).toHaveLength(1);
    expect(context.actor.state.reservations[0]?.call.requestId).toBe('original');
    const changed = { ...dispatch(context, id), callId: 'original', bodyDigest: '0'.repeat(64) };
    await expect(context.actor.admitDispatch(changed, fresh, undefined, rootTurn))
      .rejects.toThrow('Reservation binding changed');
    expect(rootTotals(context.actor.state, context.root.rootId).heldCents).toBe(1);
    for (const patch of [{ payingGroupId: 'changed' }, { priceTableId: 'changed' },
      { contextDigest: '3'.repeat(64) }]) {
      const altered = { ...again, ...patch };
      await expect(context.actor.reserve(altered, 1, fresh, undefined,
        context.root.rootId, retry, rootTurn)).rejects.toThrow('Model call retry refused');
      expect(rootTotals(context.actor.state, context.root.rootId).heldCents).toBe(1);
    }
  } finally {
    await close(context);
  }
}
it('keeps the native root turn on actor retry and refuses changed bindings without release',
  recoversNativeRootTurn);

async function recoversNativeHold() {
  const context = await setup();
  try {
    const binding = child(context, 'lost-hold');
    await admit(context, binding);
    const append = context.actor.store.append.bind(context.actor.store);
    async function loseReply(command: Parameters<typeof append>[0]) {
      const result = await append(command);
      const event = z.object({ type: z.string() }).parse(command.event);
      if (event.type === 'budget.reserved') {
        return { status: 'unavailable' as const, cause: new Error('Lost reserve reply') };
      }
      return result;
    }
    vi.spyOn(context.actor.store, 'append').mockImplementation(loseReply);
    await expect(reserve(context, binding, 110)).rejects.toThrow();
    vi.restoreAllMocks();
    await context.restartActor();
    const original = context.actor.state.reservations[0]!;
    expect(await reserve(context, binding, 110)).toBe(original.id);
    expect(context.actor.state.reservations).toHaveLength(1);
    expect(context.actor.state.reservations[0]?.amountCents).toBe(110);
    expect(typeof original.call.requestId).toBe('string');
    expect(original.call.requestId).not.toBe('');
    const allow = allowNative(context, binding);
    const granted = await nativeGrant(context, binding, 110,
      `call-${binding.turnId}-110`, allow);
    expect(granted).toEqual({ reservationId: original.id, requestId: original.call.requestId });
    expect(context.actor.state.reservations).toHaveLength(1);
    expect(context.actor.state.dispatches).toHaveLength(1);
    expect(context.actor.state.dispatches[0]?.callId).toBe(original.call.requestId);
  } finally {
    vi.restoreAllMocks();
    await close(context);
  }
}
it('recovers one native hold and its original ids after a lost append reply and writer restart',
  recoversNativeHold);

function allowNative(context: Context, binding: ReturnType<typeof child>) {
  async function allow(reservationId: string, requestId: string) {
    const payload = { requestId, route: 'model', outcome: 'allow', reason: 'model_allowed',
      contextDigest: binding.delegationId, permitId: reservationId };
    const event = envelope('test', `decision-${requestId}`, 'decision.recorded', payload);
    const command = { event, expectedSequence: 0, historyChecked: true as const };
    const result = await context.store.append(command);
    if (result.status !== 'appended') throw new Error('Decision save unavailable');
    return event.id;
  }
  return allow;
}
async function recoversNativeDecision(failure: string) {
  const context = await setup();
  try {
    const binding = child(context, 'decision');
    await admit(context, binding);
    const allow = allowNative(context, binding);
    const append = context.store.append.bind(context.store);
    let savedDecision: string | undefined;
    async function loseDecisionReply(command: Parameters<typeof append>[0]) {
      const result = await append(command);
      const event = z.object({ type: z.string(), id: z.string() }).parse(command.event);
      if (event.type === 'decision.recorded') {
        savedDecision = event.id;
        throw new Error('Lost decision reply');
      }
      return result;
    }
    vi.spyOn(context.store, 'append').mockImplementation(loseDecisionReply);
    const read = context.actor.store.readStream.bind(context.actor.store);
    async function* unknownDecision(...args: Parameters<typeof read>) {
      if (savedDecision && args[0].startsWith('decision-')) {
        throw new Error('Decision read unavailable');
      }
      yield* read(...args);
    }
    if (failure === 'unknown read') {
      vi.spyOn(context.actor.store, 'readStream').mockImplementation(unknownDecision);
      await expect(nativeGrant(context, binding, 110, 'verified-call', allow))
        .rejects.toThrow(/^Model call retry refused$/u);
      expect(rootTotals(context.actor.state, context.root.rootId).heldCents).toBe(110);
      expect(context.actor.state.dispatches).toHaveLength(0);
      vi.restoreAllMocks();
      await context.restartActor();
    }
    const granted = await nativeGrant(context, binding, 110, 'verified-call', allow);
    expect(context.actor.state.reservations).toHaveLength(1);
    expect(context.actor.state.dispatches).toMatchObject([
      { reservationId: granted.reservationId, callId: granted.requestId,
        decisionId: savedDecision, rootId: context.root.rootId },
    ]);
    const decisions = await history(context.store, `decision-${granted.requestId}`, 'test');
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.event.id).toBe(savedDecision);
    const position = await context.store.head();
    await expect(nativeGrant(context, binding, 110, 'verified-call', allow)).rejects.toThrow();
    expect(await context.store.head()).toBe(position);
    expect(rootTotals(context.actor.state, context.root.rootId).heldCents).toBe(110);
    expect(context.received()).toBe(0);
  } finally {
    vi.restoreAllMocks();
    await close(context);
  }
}
it.each(['lost reply', 'unknown read'])('recovers the exact native allow after %s',
  recoversNativeDecision);

async function refusesChangedNativeRetry(field: string) {
  const context = await setup();
  try {
    const binding = child(context, 'changed');
    await admit(context, binding);
    const raw = JSON.stringify(bodyForCents(110));
    const id = await reserve(context, binding, raw);
    const saved = context.actor.state.reservations[0]!;
    const call = { ...saved.call, requestId: 'replacement' };
    let changedRaw = raw;
    if (field === 'body') changedRaw += ' ';
    else if (field === 'generation') call.generation = 2;
    else Reflect.set(call, field, 'changed');
    const native = { callId: `call-${binding.turnId}-${raw}`,
      rootId: context.root.rootId, rootTurn };
    const allow = allowNative(context, binding);
    const position = await context.store.head();
    await expect(grantModelCall(context.actor, call, 110, changedRaw, fresh,
      undefined, allow, native)).rejects.toThrow(/^Model call retry refused$/u);
    expect(await context.store.head()).toBe(position);
    expect(context.actor.state.reservations).toHaveLength(1);
    expect(saved).toMatchObject({ id, amountCents: 110 });
    expect(saved.settledCents).toBeUndefined();
    expect(context.actor.state.dispatches).toHaveLength(0);
    // Also refuse an unverified native claim before it can release the saved hold.
    const changed = { ...binding, threadId: 'foreign' };
    await expect(nativeGrant(context, changed, raw, native.callId, allow)).rejects.toThrow();
    expect(await context.store.head()).toBe(position);
  } finally {
    await close(context);
  }
}
it.each(['body', 'payingGroupId', 'priceTableId', 'model', 'contextDigest', 'generation'])(
  'refuses native retry with changed %s without replacement or release', refusesChangedNativeRetry);

async function racesNativeRecovery() {
  const context = await setup();
  try {
    const binding = child(context, 'race');
    await admit(context, binding);
    const id = await reserve(context, binding, 110);
    const original = context.actor.state.reservations[0]!;
    const ready = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const allow = allowNative(context, binding);
    let arrivals = 0;
    async function pausedAllow(reservationId: string, requestId: string) {
      arrivals++;
      if (arrivals === 2) ready.resolve();
      await release.promise;
      return allow(reservationId, requestId);
    }
    async function leader() {
      const actor = new BudgetActor(context.store, 'test', context.actor.now);
      await actor.start();
      const callId = `call-${binding.turnId}-110`;
      const first = nativeGrant(context, binding, 110, callId, pausedAllow, context.store, actor);
      const second = nativeGrant(context, binding, 110, callId, pausedAllow,
        context.nats.store, actor);
      const replies = Promise.allSettled([first, second]);
      await ready.promise;
      let otherStarted = false;
      function otherLeader() {
        otherStarted = true;
        return Promise.resolve();
      }
      await expect(context.db.lock!('budget-leader:test', otherLeader, { timeoutMs: 30 }))
        .rejects.toThrow();
      expect(otherStarted).toBe(false);
      release.resolve();
      const results = await replies;
      function succeeded(result: typeof results[number]) {
        return result.status === 'fulfilled';
      }
      expect(results.filter(succeeded)).toEqual([
        { status: 'fulfilled', value: { reservationId: id, requestId: original.call.requestId } },
      ]);
      expect(actor.state.reservations).toHaveLength(1);
      expect(actor.state.dispatches).toHaveLength(1);
      const decisions = await history(context.store, `decision-${original.call.requestId}`, 'test');
      expect(decisions).toHaveLength(1);
      expect(actor.state.dispatches[0]?.decisionId).toBe(decisions[0]?.event.id);
      await expect(nativeGrant(context, binding, 110, callId, allow)).rejects.toThrow();
      expect(context.received()).toBe(0);
    }
    await context.db.lock!('budget-leader:test', leader);
  } finally {
    await close(context);
  }
}
it('reloads one leased writer and admits only one competing native retry', racesNativeRecovery);

async function refusesNativeDispatchAfterDecision(change: string) {
  const context = await setup();
  try {
    const binding = child(context, 'after-decision');
    await admit(context, binding);
    const allow = allowNative(context, binding);
    async function saveThenChange(reservationId: string, requestId: string) {
      const decisionId = await allow(reservationId, requestId);
      if (change === 'stop') {
        const stop = { conversationId: 'conversation', turnId: start.turnId, requestedBy: 'alice' };
        await context.append('conversation-conversation', 'agent.turn_stop_requested', stop);
        const position = await context.store.head('conversation-conversation');
        await context.actor.stopRoot(context.root.rootId, 'requester_stop',
          'conversation-conversation', position);
      } else if (change === 'deadline') {
        vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 2001);
      }
      return decisionId;
    }
    const append = context.actor.store.append.bind(context.actor.store);
    async function lostAdmission(command: Parameters<typeof append>[0]) {
      const result = await append(command);
      const event = z.object({ type: z.string() }).parse(command.event);
      if (event.type === 'budget.call_dispatch_admitted') {
        return { status: 'unavailable' as const, cause: new Error('Lost admission reply') };
      }
      return result;
    }
    if (change === 'lost admission') {
      vi.spyOn(context.actor.store, 'append').mockImplementation(lostAdmission);
    }
    await expect(nativeGrant(context, binding, 110, 'verified-call', saveThenChange))
      .rejects.toThrow(/^Model call retry refused$/u);
    vi.restoreAllMocks();
    await context.restartActor();
    const saved = context.actor.state.reservations[0]!;
    const position = await context.store.head();
    await expect(nativeGrant(context, binding, 110, 'verified-call', allow)).rejects.toThrow();
    expect(await context.store.head()).toBe(position);
    expect(context.actor.state.reservations).toHaveLength(1);
    if (change === 'lost admission') {
      expect(saved.settledCents).toBeUndefined();
      expect(context.actor.state.dispatches).toHaveLength(1);
      expect(rootTotals(context.actor.state, context.root.rootId).heldCents).toBe(110);
    } else {
      expect(saved.settledCents).toBe(0);
      expect(context.actor.state.dispatches).toHaveLength(0);
    }
    expect(context.received()).toBe(0);
  } finally {
    vi.restoreAllMocks();
    await close(context);
  }
}
it.each(['stop', 'deadline', 'lost admission'])(
  'refuses native dispatch after %s and retains only potentially sent work',
  refusesNativeDispatchAfterDecision);
