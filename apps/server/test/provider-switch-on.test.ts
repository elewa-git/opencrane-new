import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { createEventStore } from '@opencrane/event-store';
import { encodeSession } from '@opencrane/auth';
import { parseEventByType } from '@opencrane/events';
import { event } from '@opencrane/event-store/testing';
import { BudgetActor, budgets, history, ingestUsage, managedProviderCallsEnabled,
  priceTableId, providerCommand, providerSecretRef, readBudget, totals } from '@opencrane/models';
import { fixture } from '../../../libs/models/test/fixture.ts';
import { buildServer } from '../src/server.ts';
import { turnCommand } from '../src/chat/turns.ts';
import { testAuthConfig } from './support/test-auth-config.ts';

const config = testAuthConfig({ expectedOrgId: 'org-acme' });
let setup: Awaited<ReturnType<typeof fixture>>;
let app: ReturnType<typeof buildServer>;
let counter = 0;
const provider = { providerId: 'primary', revision: 3, changedBy: 'alice' };
const turn = { assistantId: 'assistant', computerId: 'computer', conversationId: 'conversation',
  turnId: 'legacy', threadId: 'legacy-thread', requesterId: 'alice', task: 'chat_turn' };

async function choice(patch: Record<string, unknown> = {}, automatic = false) {
  const data = { ...provider, kind: 'silo_default', dependantId: 'test', task: 'chat_turn',
    state: 'active', model: 'gpt-6-luna', expectedProviderSequence: 0,
    previousBindingSequence: 0, ...patch };
  const record = { ...event(`choice-${++counter}`, `provider-${String(data.providerId)}`),
    type: 'provider.model_binding_set', data };
  if (automatic) {
    record.commandId = 'system:seed-provider-default';
  }
  await setup.nats.seed([record]);
}
async function drain(draining = true) {
  const data = { ...provider, draining, expectedProviderSequence: 0, expectedDrainSequence: 0 };
  await setup.append('provider-primary', 'provider.managed_calls_drain_set', data);
}
async function initialise(withDefault = true) {
  setup = await fixture();
  await setup.append('computer-assistant', 'computer.turn_closed',
    { ...turn, turnId: 'turn', status: 'completed' });
  const created = await setup.append('provider-primary', 'provider.created',
    { ...provider, revision: 1, provider: 'openai', name: 'Primary' });
  await setup.auth.handler.handle(created, setup.db);
  const key = { action: 'key', providerId: 'primary', commandId: 'saved-key', expectedRevision: 1,
    secretRef: providerSecretRef('test', 'primary', 'saved-key') };
  await providerCommand(setup.nats.store, setup.binding, 'alice', key);
  await setup.append('provider-primary', 'provider.verification_recorded',
    { ...provider, revision: 2, kind: 'reachability', attemptId: 'check', outcome: 'pass' });
  await setup.append('provider-primary', 'provider.models_selected',
    { ...provider, models: ['gpt-6-luna', 'gpt-6.1-sol'] });
  if (withDefault) {
    await choice();
  }
  await drain();
  buildApp();
}
function unusedCustody() {
  return Promise.reject<never>(new Error('Unexpected custody access'));
}
const secrets = { read: vi.fn(unusedCustody), save: vi.fn(unusedCustody),
  remove: vi.fn(unusedCustody) };
function buildApp() {
  function memberId(_silo: string, _issuer: string, sub: string) {
    return Promise.resolve(sub);
  }
  const options = { silo: 'test', binding: setup.binding, store: setup.nats.store,
    db: setup.db, feed: { memberId }, secrets };
  app = buildServer(config, { providers: options });
}
async function initialFixture() {
  await initialise();
}
beforeEach(initialFixture, 120_000);
async function close() {
  vi.restoreAllMocks();
  await app?.close();
  await setup?.close();
}
afterEach(close);
function request(payload?: unknown, suffix = 'switch-on', sub = 'alice',
  origin = 'https://app.example.test', orgId = 'org-acme', providerId = 'primary') {
  const session = { sub, orgId, roles: ['owner'], authTime: 1, exp: 2000000000 };
  const cookie = `${config.cookieName}=${encodeSession(config, session)}`;
  const headers = { origin, 'content-type': 'application/json', cookie };
  const options = { method: payload === undefined ? 'GET' as const : 'POST' as const,
    url: `/api/org/providers/${providerId}/${suffix}`, headers,
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }) };
  return app.inject(options);
}
async function input(patch: Record<string, unknown> = {}) {
  const status = await request(undefined, 'drain');
  return { commandId: `switch-${++counter}`, expectedRevision: 3,
    expectedProviderSequence: await setup.nats.store.head('provider-*'),
    expectedDrainSequence: status.json<{ sequence: number }>().sequence, ...patch };
}
async function refused(code: number, patch: Record<string, unknown> = {}) {
  const command = await input(patch);
  const before = await setup.nats.store.head();
  expect((await request(command)).statusCode).toBe(code);
  expect(await setup.nats.store.head()).toBe(before);
}
async function stale(patch: Record<string, unknown>) {
  await refused(409, patch);
}
it.each([{ expectedRevision: 2 }, { expectedProviderSequence: 0 },
  { expectedDrainSequence: 0 }, { commandId: 'saved-key' }])('refuses stale input %j without saving', stale);
async function noDrain() {
  await drain(false);
  await refused(403);
}
it('requires an active drain', noDrain);
async function missingDefault() {
  await close();
  await initialise(false);
  await refused(403);
}
it('requires a saved silo default', missingDefault);
async function invalidDefault(patch: Record<string, unknown>, automatic: boolean) {
  if (patch['providerId'] === 'other') {
    await setup.append('provider-other', 'provider.created', { providerId: 'other', revision: 1,
      changedBy: 'alice', provider: 'openai', name: 'Other' });
    patch = { ...patch, revision: 1 };
  }
  await choice(patch, automatic);
  await refused(403);
}
it.each([[{ state: 'paused', reason: 'Paused by an administrator' }, false], [{}, true],
  [{ providerId: 'other' }, false], [{ model: 'unknown' }, false]] as const)(
  'refuses an unsuitable or automatic default %j', invalidDefault);
async function invalidConnection(kind: string) {
  const created = { providerId: 'other', revision: 1, changedBy: 'alice',
    provider: 'openai', name: 'Other' };
  await setup.append('provider-other', 'provider.created', created);
  if (kind !== 'missing key') {
    await setup.append('provider-other', 'provider.key_saved', { providerId: 'other', changedBy: 'alice',
      revision: 2, secretRef: providerSecretRef('test', 'other', 'saved') });
  }
  if (kind === 'disabled model') {
    await setup.append('provider-other', 'provider.verification_recorded', {
      providerId: 'other', revision: 2, changedBy: 'alice', kind: 'reachability',
      attemptId: 'check', outcome: 'pass',
    });
  }
  await choice({ providerId: 'other', revision: kind === 'missing key' ? 1 : 2,
    kind: 'assistant', dependantId: 'assistant' });
  await refused(403);
}
it.each(['missing key', 'missing reachability', 'disabled model'])('refuses active bindings with %s', invalidConnection);
async function legacy(end: string) {
  await setup.append('computer-assistant', 'computer.turn_started', turn);
  await refused(403);
  if (end === 'closed') {
    await setup.append('computer-assistant', 'computer.turn_closed', { ...turn, status: 'completed' });
  } else {
    const data = { assistantId: 'assistant', computerId: 'computer',
      ...(end === 'claimed' ? { tokenId: 'token:replacement', generation: 2 } : {}) };
    await setup.append('computer-assistant', `computer.${end}`, data);
  }
  expect((await request(await input())).statusCode).toBe(200);
}
it.each(['closed', 'lost', 'retired', 'claimed'])('waits for legacy work to be %s', legacy);
async function openHoldAfterLoss() {
  await setup.append('computer-assistant', 'computer.turn_started', turn);
  const call = { model: 'gpt-6-luna', priceTableId, payingGroupId: 'sales',
    assistantId: 'assistant', computerId: 'computer', conversationId: 'conversation',
    turnId: 'legacy', threadId: 'legacy-thread', requesterId: 'alice',
    contextDigest: 'a'.repeat(64), requestId: 'held-call' };
  const reservationId = await setup.actor.reserve(call, 12);
  await setup.append('computer-assistant', 'computer.lost',
    { assistantId: 'assistant', computerId: 'computer' });
  await refused(403);
  await setup.actor.releaseUndispatched(reservationId);
  expect((await request(await input())).statusCode).toBe(200);
  expect(setup.actor.state.reservations).toMatchObject([
    { id: reservationId, amountCents: 12, settledCents: 0 },
  ]);
}
it('refuses an open hold after computer loss until its zero-cost release', openHoldAfterLoss);

async function openSendAfterClosure() {
  await setup.append('computer-assistant', 'computer.turn_started', turn);
  const modelCall = { model: 'mcp-zero-cost', priceTableId: 'zero', payingGroupId: 'sales',
    assistantId: 'assistant', computerId: 'computer', conversationId: 'conversation',
    turnId: 'legacy', threadId: 'legacy-thread', requesterId: 'alice',
    contextDigest: 'a'.repeat(64), requestId: 'free-send' };
  const dispatch = { callId: 'free-send', decisionId: 'free-decision',
    bodyDigest: 'b'.repeat(64), modelCall };
  async function fresh() {}
  await setup.actor.admitDispatch(dispatch, fresh);
  await setup.append('computer-assistant', 'computer.turn_closed', { ...turn, status: 'completed' });
  await refused(403);
}
it('refuses an admitted send without settlement after its turn closes', openSendAfterClosure);

async function settledSendAfterClosure() {
  await setup.append('computer-assistant', 'computer.turn_started', turn);
  const modelCall = { model: 'gpt-6-luna', priceTableId, payingGroupId: 'sales',
    assistantId: 'assistant', computerId: 'computer', conversationId: 'conversation',
    turnId: 'legacy', threadId: 'legacy-thread', requesterId: 'alice',
    contextDigest: 'a'.repeat(64), requestId: 'paid-send' };
  const reservationId = await setup.actor.reserve(modelCall, 12);
  const admission = { requestId: 'paid-send', permitId: reservationId, route: 'model',
    outcome: 'allow', reason: 'model_allowed', contextDigest: modelCall.contextDigest };
  await setup.append('decision-paid-send', 'decision.recorded', admission);
  const dispatch = { callId: 'paid-send', decisionId: 'paid-decision',
    bodyDigest: 'b'.repeat(64), reservationId, modelCall };
  async function fresh() {}
  await setup.actor.admitDispatch(dispatch, fresh);
  await setup.append('computer-assistant', 'computer.turn_closed', { ...turn, status: 'completed' });
  await refused(403);
  await setup.actor.effect(reservationId, { inputTokens: 1000, outputTokens: 120 });
  await setup.settled();
  expect((await request(await input())).statusCode).toBe(200);
  expect(setup.actor.state.reservations).toMatchObject([
    { id: reservationId, amountCents: 12, settledCents: 1, call: modelCall },
  ]);
}
it('allows switch-on after an admitted send settles at its original tariff and payer',
  settledSendAfterClosure);

async function unresolvedHold(kind: 'expired' | 'unknown') {
  const reservationId = 'unresolved-hold';
  const reservation = { reservationId, permitId: reservationId, amountCents: 12,
    payingGroupId: 'sales', assistantId: 'assistant' };
  await setup.append('budget-test', 'budget.reserved', reservation);
  if (kind === 'expired') {
    await setup.append('budget-test', 'budget.reservation_expired', { reservationId });
  } else {
    const settlement = { reservationId, permitId: reservationId,
      settledCents: 0, outcome: 'unknown' };
    await setup.append('budget-test', 'budget.settled', settlement);
  }
  await refused(403);
}
it.each(['expired', 'unknown'] as const)('refuses a hold whose outcome is %s', unresolvedHold);

async function denied(reason: string) {
  const command = await input();
  let sub = 'alice';
  let origin = 'https://app.example.test';
  let orgId = 'org-acme';
  if (reason === 'member') {
    sub = 'bob';
    const joined = await setup.append('member-bob', 'member.joined', {
      memberId: 'bob', email: 'bob@example.test', displayName: 'Bob', role: 'member',
    });
    await setup.auth.handler.handle(joined, setup.db);
  }
  if (reason === 'origin') {
    origin = 'https://forged.test';
  }
  if (reason === 'silo') {
    orgId = 'foreign';
  }
  if (reason === 'departed') {
    await setup.append('member-alice', 'member.removed', { memberId: 'alice', removedBy: 'owner' });
  }
  if (reason === 'revoked') {
    await setup.append('member-alice', 'member.role_changed',
      { memberId: 'alice', previousRole: 'owner', newRole: 'member', changedBy: 'owner' });
  }
  const before = await setup.nats.store.head();
  const response = await request(command, 'switch-on', sub, origin, orgId);
  expect(response.statusCode).toBe(403);
  expect(response.json()).toEqual({ status: 'refused' });
  if (reason !== 'origin') {
    const status = await request(undefined, `changes/${command.commandId}`, sub, origin, orgId);
    expect(status.statusCode).toBe(403);
    expect(status.json()).toEqual({ status: 'refused' });
  }
  expect(await setup.nats.store.head()).toBe(before);
}
it.each(['member', 'departed', 'revoked', 'origin', 'silo'])('refuses %s access', denied);
async function recovers() {
  const command = await input();
  const before = await setup.nats.store.head();
  const append = setup.nats.store.append.bind(setup.nats.store);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  async function lost(change: Parameters<typeof append>[0]): Promise<never> {
    entered.resolve();
    await release.promise;
    await append(change);
    throw new Error('Lost reply');
  }
  vi.spyOn(setup.nats.store, 'append').mockImplementationOnce(lost);
  const pending = Promise.resolve(request(command));
  try {
    await Promise.race([entered.promise, pending]);
    expect((await request(undefined, `changes/${command.commandId}`)).json()).toEqual(
      { status: 'not_found' });
  } finally {
    release.resolve();
  }
  expect((await pending).statusCode).toBe(503);
  const saved = await request(command);
  expect(saved.statusCode).toBe(200);
  expect(saved.json()).toMatchObject({ operation: 'provider.managed_calls_enabled' });
  expect((await request(command)).json()).toEqual(saved.json());
  expect((await request(undefined, `changes/${command.commandId}`)).json()).toMatchObject(saved.json());
  expect((await request({ ...command, expectedDrainSequence: 0 })).statusCode).toBe(409);
  expect((await request({ ...command, commandId: 'another' })).statusCode).toBe(403);
  expect(await setup.nats.store.head()).toBe(before + 1);
  expect((await request(undefined, 'drain')).json()).toMatchObject({ enabled: true, draining: false });
  expect((await setup.call()).status).toBe(403);
  expect(setup.actor.state.reservations).toHaveLength(0);
  expect(setup.received()).toBe(0);
  const later = { action: 'models', providerId: 'primary', commandId: command.commandId,
    expectedRevision: 3, models: ['gpt-6-luna'] };
  await providerCommand(setup.nats.store, setup.binding, 'alice', later);
  expect((await request(undefined, `changes/${command.commandId}`)).json()).toMatchObject(saved.json());
}
it('records one marker and recovers the original receipt after a lost reply', recovers);
async function races(kind: string) {
  const command = await input();
  const before = await setup.nats.store.head();
  const append = setup.nats.store.append.bind(setup.nats.store);
  let intercepted = false;
  async function competing(change: Parameters<typeof append>[0]) {
    const parsed = parseEventByType(change.event);
    if (parsed.success && parsed.event.type === 'provider.managed_calls_enabled' && !intercepted) {
      intercepted = true;
      if (kind === 'cancel') {
        await drain(false);
      }
      if (kind === 'pause') {
        await choice({ state: 'paused', reason: 'Paused by an administrator' });
      }
      if (kind === 'legacy') {
        await setup.append('computer-assistant', 'computer.turn_started', turn);
      }
      if (kind === 'reservation') {
        await setup.actor.reserve({ model: 'gpt-6-luna', priceTableId,
          computerId: 'computer', assistantId: 'assistant', requesterId: 'alice',
          conversationId: 'conversation', turnId: 'turn', threadId: 'thread',
          payingGroupId: 'sales', contextDigest: 'a'.repeat(64), requestId: 'race' }, 1);
      }
      if (kind === 'switch') {
        expect((await request({ ...command, commandId: 'competing' })).statusCode).toBe(200);
      }
    }
    return append(change);
  }
  vi.spyOn(setup.nats.store, 'append').mockImplementation(competing);
  expect((await request(command)).statusCode).toBe(409);
  expect(intercepted).toBe(true);
  expect(await setup.nats.store.head()).toBe(before + 1);
}
it.each(['cancel', 'pause', 'legacy', 'reservation', 'switch'])(
  'refuses when %s saves after the final check', races);
async function lateStart() {
  await drain(false);
  const message = await setup.append('conversation-conversation', 'message.posted', {
    conversationId: 'conversation', authorId: 'alice', authorKind: 'human', contentType: 'text',
    ciphertext: 'ZmFrZS1jaXBoZXJ0ZXh0', keyId: 'key:1',
  });
  const context = { silo: 'test', assistantId: 'assistant', computerId: 'computer' };
  const start = { conversationId: 'conversation', turnId: message.id,
    threadId: 'late-thread', status: 'started' as const };
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const append = setup.nats.store.append.bind(setup.nats.store);
  async function delayed(change: Parameters<typeof append>[0]) {
    const parsed = parseEventByType(change.event);
    if (parsed.success && parsed.event.type === 'computer.turn_started') {
      entered.resolve();
      await release.promise;
    }
    return append(change);
  }
  vi.spyOn(setup.nats.store, 'append').mockImplementation(delayed);
  const pending = turnCommand(setup.nats.store, context, start);
  try {
    await entered.promise;
    await drain();
    const command = await input();
    expect((await request(undefined, `changes/${command.commandId}`)).json()).toEqual(
      { status: 'not_found' });
    expect((await request(command)).statusCode).toBe(200);
  } finally {
    release.resolve();
  }
  expect(await pending).not.toHaveProperty('providerId');
  const token = await setup.sign({ ...setup.t, turn: message.id, thread: 'late-thread' },
    'decision-service');
  expect((await setup.call({ ...setup.headers, 'x-turn-token': token })).status).toBe(403);
  expect(setup.actor.state.reservations).toHaveLength(0);
  expect(setup.received()).toBe(0);
}
it('refuses a legacy admission released after drain and switch-on before any hold or send', lateStart);

async function newChoice(kind: 'assistant' | 'silo_default') {
  if (kind === 'assistant') {
    await choice({ kind, dependantId: 'assistant', model: 'gpt-6.1-sol' });
    const changed = await setup.append('member-alice', 'member.role_changed', {
      memberId: 'alice', previousRole: 'owner', newRole: 'admin', changedBy: 'alice',
    });
    await setup.auth.handler.handle(changed, setup.db);
  }
  expect((await request(await input())).statusCode).toBe(200);
  const message = await setup.append('conversation-conversation', 'message.posted', {
    conversationId: 'conversation', authorId: 'alice', authorKind: 'human', contentType: 'text',
    ciphertext: 'ZmFrZS1jaXBoZXJ0ZXh0', keyId: 'key:1',
  });
  const context = { silo: 'test', assistantId: 'assistant', computerId: 'computer' };
  const start = { conversationId: 'conversation', turnId: message.id,
    threadId: 'new-thread', status: 'started' as const };
  const admitted = await turnCommand(setup.nats.store, context, start);
  const model = kind === 'assistant' ? 'gpt-6.1-sol' : 'gpt-6-luna';
  expect(admitted).toMatchObject({ providerId: 'primary', model });
}
it.each(['assistant', 'silo_default'] as const)('new turns use the %s choice', newChoice);

async function creationReceipt() {
  const command = await input();
  let createdId: string | undefined;
  for await (const row of setup.nats.store.readStream('provider-primary')) {
    createdId = row.event.id;
    break;
  }
  const applied = setup.auth.applied.bind(setup.auth);
  async function withoutProviderReceipt(eventId: string) {
    return eventId !== createdId && await applied(eventId);
  }
  vi.spyOn(setup.auth, 'applied').mockImplementation(withoutProviderReceipt);
  const before = await setup.nats.store.head();
  expect((await request(command)).statusCode).toBe(403);
  expect(await setup.nats.store.head()).toBe(before);
}
it('requires the provider creation receipt even when manage permission already exists', creationReceipt);

async function legacyDuringReads() {
  const command = await input();
  const before = await setup.nats.store.head();
  const read = setup.nats.store.readStream.bind(setup.nats.store);
  let saved = false;
  async function* changedRead(...args: Parameters<typeof read>) {
    yield* read(...args);
    if (args[0] === 'provider-*' && !saved) {
      saved = true;
      await setup.append('computer-assistant', 'computer.turn_started', turn);
    }
  }
  vi.spyOn(setup.nats.store, 'readStream').mockImplementation(changedRead);
  expect((await request(command)).statusCode).toBe(409);
  expect(saved).toBe(true);
  expect(await setup.nats.store.head()).toBe(before + 1);
}
it('reports a conflict when a legacy start arrives between the history reads', legacyDuringReads);


const originalCall = {
  model: 'gpt-6-luna', priceTableId, payingGroupId: 'sales',
  assistantId: 'assistant', computerId: 'computer', conversationId: 'conversation',
  turnId: 'legacy', threadId: 'legacy-thread', requesterId: 'alice',
  contextDigest: 'a'.repeat(64), requestId: 'proof-call',
};

async function heldCall(permitted = true, dispatched = true) {
  // Deliver settlement explicitly so each race has a controlled order.
  await setup.stopDispatch();
  await setup.runtime.stop();
  const reservationId = await setup.actor.reserve(originalCall, 12);
  if (permitted) {
    const admission = { requestId: originalCall.requestId, permitId: reservationId,
      route: 'model', outcome: 'allow', reason: 'model_allowed',
      contextDigest: originalCall.contextDigest };
    await setup.append('decision-proof-call', 'decision.recorded', admission);
  }
  if (dispatched) {
    const dispatch = { callId: originalCall.requestId, decisionId: 'proof-decision',
      bodyDigest: 'b'.repeat(64), reservationId, modelCall: originalCall };
    async function fresh() {}
    await setup.actor.admitDispatch(dispatch, fresh);
  }
  return reservationId;
}

async function recordUsage(reservationId: string, inputTokens = 1000) {
  const usage = { id: reservationId, inputTokens, outputTokens: 120 };
  const line = JSON.stringify(usage) + '\n';
  await writeFile(setup.options.usageFile, line + line);
  await ingestUsage(setup.actor, setup.options.usageFile);
  const effects = await history(setup.nats.store, `effect-${reservationId}`, 'test');
  const observed = effects.at(-1)!;
  await setup.actor.settleRecorded(reservationId, observed.event.id);
  return observed.event.id;
}

async function spendingRecords() {
  const rows = await history(setup.nats.store, 'budget-test', 'test');
  function changesMoneyOrMode(row: typeof rows[number]) {
    return ['budget.reserved', 'budget.call_dispatch_admitted', 'budget.settled',
      'provider.managed_calls_enabled'].includes(row.event.type);
  }
  return rows.filter(changesMoneyOrMode);
}

async function replaySwitch(command: Awaited<ReturnType<typeof input>>, receipt: unknown,
  reservationId: string, settledCents: number, effectId?: string) {
  await setup.runner.run(budgets);
  const before = await readBudget(setup.db, 'test');
  const records = await spendingRecords();
  const keysRead = secrets.read.mock.calls.length;
  await app.close();
  await setup.decisionDown();
  // Use a new store object so restart cannot reuse the previous process's summaries.
  setup.nats.store = await createEventStore(setup.nats.connection);
  const recovered = new BudgetActor(setup.nats.store, 'test', setup.actor.now);
  await recovered.start();
  buildApp();
  if (effectId) {
    await recovered.settleRecorded(reservationId, effectId);
  } else {
    await recovered.releaseUndispatched(reservationId);
  }
  await setup.runner.rebuild(budgets);
  const after = await readBudget(setup.db, 'test');
  expect(after.reservations).toEqual(before.reservations);
  expect(totals(after, recovered.now())).toEqual(totals(before, recovered.now()));
  expect(recovered.state.reservations).toEqual(before.reservations);
  expect(await managedProviderCallsEnabled(setup.nats.store, 'test',
    performance.now() + 10_000)).toBe(true);
  expect((await request(undefined, 'drain')).json()).toMatchObject(
    { enabled: true, draining: false });
  expect((await request(command)).json()).toEqual(receipt);
  expect(await spendingRecords()).toEqual(records);
  expect(secrets.read.mock.calls).toHaveLength(keysRead);
  expect(setup.received()).toBe(0);
  const payer = { scope: 'paying_group' as const, scopeId: 'sales' };
  expect(totals(after, recovered.now(), payer)).toMatchObject(
    { reservedCents: 0, monthCents: settledCents });
  const otherPayer = { ...payer, scopeId: 'personal-default' };
  expect(totals(after, recovered.now(), otherPayer)).toMatchObject(
    { reservedCents: 0, monthCents: 0 });
}

async function settlementProof() {
  const reservationId = await heldCall();
  await refused(403);
  // Change the default model after admission; usage must still use the held call's tariff.
  await choice({ model: 'gpt-6.1-sol' });
  const effectId = await recordUsage(reservationId);
  const command = await input();
  const response = await request(command);
  expect(response.statusCode).toBe(200);
  const before = await setup.nats.store.head();
  await ingestUsage(setup.actor, setup.options.usageFile);
  await setup.actor.settleRecorded(reservationId, effectId);
  expect(await setup.nats.store.head()).toBe(before);
  expect(setup.actor.state.reservations).toMatchObject([
    { id: reservationId, call: originalCall, amountCents: 12, settledCents: 1 },
  ]);
  const effects = await history(setup.nats.store, `effect-${reservationId}`, 'test');
  expect(effects).toHaveLength(1);
  const records = await spendingRecords();
  function isSettlement(row: typeof records[number]) {
    return row.event.type === 'budget.settled';
  }
  expect(records.filter(isSettlement)).toHaveLength(1);
  await replaySwitch(command, response.json(), reservationId, 1, effectId);
}
it('proves switch-on settlement once after duplicate usage, redelivery and replay', settlementProof);

async function releaseProof() {
  const reservationId = await heldCall(false, false);
  await refused(403);
  await setup.actor.releaseUndispatched(reservationId);
  const command = await input();
  const response = await request(command);
  expect(response.statusCode).toBe(200);
  const before = await setup.nats.store.head();
  await setup.actor.releaseUndispatched(reservationId);
  expect(await setup.nats.store.head()).toBe(before);
  const records = await spendingRecords();
  expect(records).toHaveLength(3);
  expect(records[1]?.event.data).toEqual({ reservationId, permitId: reservationId,
    settledCents: 0, outcome: 'not_dispatched' });
  await replaySwitch(command, response.json(), reservationId, 0);
}
it('proves an unsent hold releases once at zero and stays released after switch-on replay',
  releaseProof);

async function stillBlocked(kind: 'dispatched' | 'unknown') {
  const reservationId = await heldCall();
  if (kind === 'unknown') {
    await recordUsage(reservationId);
    await recordUsage(reservationId, 200_000);
    expect(setup.actor.state.reservations[0]?.outcomeUnknown).toBe(true);
  }
  await setup.append('computer-assistant', 'computer.turn_closed',
    { ...turn, status: 'completed' });
  await refused(403);
  await expect(setup.actor.releaseUndispatched(reservationId)).rejects.toThrow();
  await refused(403);
}
it.each(['dispatched', 'unknown'] as const)(
  'keeps a potentially sent hold blocked when %s despite closure and attempted release', stillBlocked);

async function completionRace(kind: 'settlement' | 'release') {
  const permitted = kind === 'settlement';
  const reservationId = await heldCall(permitted, permitted);
  const command = await input();
  const head = setup.nats.store.head.bind(setup.nats.store);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  async function captured(...args: Parameters<typeof head>) {
    const sequence = await head(...args);
    entered.resolve();
    await release.promise;
    return sequence;
  }
  vi.spyOn(setup.nats.store, 'head').mockImplementationOnce(captured);
  const pending = Promise.resolve(request(command));
  try {
    await entered.promise;
    if (permitted) {
      await recordUsage(reservationId);
    } else {
      await setup.actor.releaseUndispatched(reservationId);
    }
  } finally {
    release.resolve();
  }
  const conflicted = await pending;
  expect(conflicted.statusCode).toBe(409);
  expect(conflicted.json()).toEqual({ status: 'refused' });
  const saved = await request(command);
  expect(saved.statusCode).toBe(200);
  expect((await request(command)).json()).toEqual(saved.json());
}
it.each(['settlement', 'release'] as const)(
  'conflicts when %s saves after switch-on captures history, then recovers one receipt',
  completionRace);

async function lostReplyWithCompletion(kind: 'settlement' | 'release' | 'unknown') {
  const permitted = kind !== 'release';
  const reservationId = await heldCall(permitted, kind === 'settlement');
  let effectId: string | undefined;
  if (kind === 'settlement') {
    effectId = await recordUsage(reservationId);
  } else {
    await setup.actor.releaseUndispatched(reservationId);
  }
  const command = await input();
  const append = setup.nats.store.append.bind(setup.nats.store);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  async function lost(change: Parameters<typeof append>[0]) {
    const result = await append(change);
    const parsed = parseEventByType(change.event);
    if (parsed.success && parsed.event.type === 'provider.managed_calls_enabled') {
      expect(result.status).toBe('appended');
      entered.resolve();
      await release.promise;
      throw new Error('Lost reply');
    }
    return result;
  }
  vi.spyOn(setup.nats.store, 'append').mockImplementation(lost);
  const pending = Promise.resolve(request(command));
  try {
    await entered.promise;
    if (effectId) {
      await setup.actor.settleRecorded(reservationId, effectId);
    } else if (kind === 'unknown') {
      await setup.actor.uncertain(reservationId, 'transport_failure');
    } else {
      await setup.actor.releaseUndispatched(reservationId);
    }
  } finally {
    release.resolve();
  }
  expect((await pending).statusCode).toBe(503);
  const retry = await request(command);
  const status = await request(undefined, `changes/${command.commandId}`);
  expect(status.statusCode).toBe(200);
  if (kind === 'unknown') {
    expect(setup.actor.state.reservations[0]?.outcomeUnknown).toBe(true);
    expect(retry.statusCode).toBe(403);
    expect(retry.json()).toEqual({ status: 'refused' });
    await refused(403);
  } else {
    expect(retry.statusCode).toBe(200);
    expect(status.json()).toMatchObject(retry.json());
    expect((await request(command)).json()).toEqual(retry.json());
  }
  const records = await spendingRecords();
  function isMarker(row: typeof records[number]) {
    return row.event.type === 'provider.managed_calls_enabled';
  }
  expect(records.filter(isMarker)).toHaveLength(1);
  expect(setup.received()).toBe(0);
}
it.each(['settlement', 'release', 'unknown'] as const)(
  'checks %s saved while the switch-on append reply is lost', lostReplyWithCompletion);


async function lateSettlementBeforeAppend() {
  const reservationId = await heldCall();
  await recordUsage(reservationId);
  const command = await input();
  const append = setup.nats.store.append.bind(setup.nats.store);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  async function delayed(change: Parameters<typeof append>[0]) {
    const parsed = parseEventByType(change.event);
    if (parsed.success && parsed.event.type === 'provider.managed_calls_enabled') {
      entered.resolve();
      await release.promise;
    }
    return append(change);
  }
  vi.spyOn(setup.nats.store, 'append').mockImplementation(delayed);
  const pending = Promise.resolve(request(command));
  try {
    await entered.promise;
    await recordUsage(reservationId, 200_000);
  } finally {
    release.resolve();
  }
  expect((await pending).statusCode).toBe(409);
  expect((await request(command)).statusCode).toBe(403);
  const status = await request(undefined, `changes/${command.commandId}`);
  expect(status.json()).toEqual({ status: 'not_found' });
  const enabled = await managedProviderCallsEnabled(setup.nats.store, 'test',
    performance.now() + 10_000);
  expect(enabled).toBe(false);
}
it('conflicts when late settlement reopens a hold immediately before the switch-on append',
  lateSettlementBeforeAppend);
