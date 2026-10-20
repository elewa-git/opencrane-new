import { setTimeout as delay } from 'node:timers/promises';
import { agentTurnStopRequestedDataSchema } from '@opencrane/events';
import { connectEventStore } from '@opencrane/event-store';
import { budgetStopStatusSchema } from '@opencrane/protocol';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { encodeSession } from '@opencrane/auth';
import { testAuthConfig } from '@opencrane/auth/testing';
import { conversations } from '@opencrane/projections';
import * as models from '@opencrane/models';
import { budgetStopHandler, history, priceTableId } from '@opencrane/models';
import { fixture } from '@opencrane/models/testing';
import { buildServer } from '../src/server.ts';

let setup: Awaited<ReturnType<typeof fixture>>;
let app: ReturnType<typeof buildServer>;
let turnId: string;
const config = testAuthConfig({ expectedOrgId: 'org-test' });
function headers(sub = 'alice', orgId = 'org-test') {
  const session = { sub, orgId, roles: [], authTime: 0,
    exp: Math.floor(Date.now() / 1000) + 3600 };
  return { cookie: `${config.cookieName}=${encodeSession(config, session)}` };
}
function memberId(_silo: string, _issuer: string, sub: string) {
  return Promise.resolve(sub);
}
async function initialise() {
  setup = undefined!;
  app = undefined!;
  setup = await fixture();
  await setup.runner.initialise(conversations);
  const chat = { silo: 'test', store: setup.nats.store, db: setup.db, keys: setup.keys,
    binding: setup.binding, feed: { memberId } };
  app = buildServer(config, { chat });
  await finish('turn');
  turnId = await message();
}
async function close() {
  vi.restoreAllMocks();
  const currentApp = app;
  app = undefined!;
  await currentApp?.close();
  const currentSetup = setup;
  setup = undefined!;
  await currentSetup?.close();
}
beforeEach(initialise);
afterEach(close);
async function message(conversationId = 'conversation') {
  const saved = await setup.append(`conversation-${conversationId}`, 'message.posted', {
    conversationId, authorKind: 'human', authorId: 'alice',
    ciphertext: 'ZmFrZS1jaXBoZXJ0ZXh0', keyId: 'key:1', contentType: 'text' });
  return saved.id;
}
function read(id = turnId, sub = 'alice', orgId = 'org-test') {
  const request = { url: `/api/conversations/conversation/budget-stops?turnId=${id}`,
    headers: headers(sub, orgId) };
  return app.inject(request);
}
async function stop(deliver = true) {
  await setup.actor.configure({ scope: 'paying_group', scopeId: 'personal-default',
    ceilingCents: 0, setBy: 'alice' });
  const rows = await history(setup.nats.store, 'budget-test', 'test');
  const event = rows.at(-1)!.event;
  if (deliver) {
    await setup.runner.run(conversations);
    await budgetStopHandler(setup.nats.store).handle(event, setup.db);
  }
  return event.id;
}
async function reportsQueuedStop() {
  const stopId = await stop();
  const response = await read();
  expect(response.statusCode).toBe(200);
  const result = budgetStopStatusSchema.parse(response.json());
  expect(result).toMatchObject({ status: 'stopped', stopId,
    reasons: [{ scope: 'paying_group', period: 'monthly', cause: 'zero_ceiling',
      limitCents: 0, remedy: 'ask_admin' }] });
  if (result.status !== 'stopped') throw new Error('Expected stopped');
  expect(result.work).toContainEqual({ turnId, execution: 'not_started' });
  expect(response.headers['cache-control']).toBe('no-store');
}
it('reads the saved queued stop with its reason and requester limit', reportsQueuedStop);

async function deliverLatest() {
  const rows = await history(setup.nats.store, 'budget-test', 'test');
  await setup.runner.run(conversations);
  await budgetStopHandler(setup.nats.store).handle(rows.at(-1)!.event, setup.db);
}
async function start(id = turnId, payer = 'personal-default') {
  await setup.append('computer-assistant', 'computer.turn_started', {
    assistantId: 'assistant', computerId: 'computer', conversationId: 'conversation',
    turnId: id, threadId: id, requesterId: 'alice', task: 'chat_turn', payingGroupId: payer });
}
async function finish(id = turnId) {
  await setup.append('computer-assistant', 'computer.turn_closed', {
    assistantId: 'assistant', computerId: 'computer', conversationId: 'conversation',
    turnId: id, requesterId: 'alice', task: 'chat_turn', status: 'completed' });
}
async function participant(memberId: string, role: string, add = true) {
  const joined = await setup.append(`member-${memberId}`, 'member.joined', {
    memberId, email: `${memberId}@example.test`, displayName: memberId, role });
  await setup.auth.handler.handle(joined, setup.db);
  if (!add) return;
  const added = await setup.append('participation-conversation', 'participant.added', {
    conversationId: 'conversation', participantId: memberId, addedBy: 'alice' });
  await setup.auth.handler.handle(added, setup.db);
}
async function remove(memberId = 'alice') {
  const removed = await setup.append('participation-conversation', 'participant.removed', {
    conversationId: 'conversation', participantId: memberId, removedBy: 'alice' });
  await setup.auth.handler.handle(removed, setup.db);
}
const scopes = ['paying_group', 'assistant', 'monthly', 'daily', 'both'] as const;
async function reasonsForScope(scope: typeof scopes[number]) {
  if (scope === 'paying_group' || scope === 'assistant') {
    const scopeId = scope === 'assistant' ? 'assistant' : 'personal-default';
    await setup.actor.configure({ scope, scopeId, ceilingCents: 1, setBy: 'alice' });
  } else {
    const ceilingCents = scope === 'daily' ? 20000 : 1;
    const dailyCeilingCents = scope === 'monthly' ? 2000 : 1;
    await setup.actor.configure({ scope: 'global', ceilingCents, dailyCeilingCents,
      defaultPayingGroupId: 'personal-default', setBy: 'alice' });
  }
  const call = { model: 'gpt-6-luna', priceTableId, computerId: 'computer',
    assistantId: 'assistant', requesterId: 'alice', conversationId: 'conversation',
    turnId, threadId: turnId, payingGroupId: 'personal-default', contextDigest: '0'.repeat(64) };
  await expect(setup.actor.reserve(call, 2)).rejects.toThrow('spending');
  await deliverLatest();
  const response = await read();
  expect(response.statusCode).toBe(200);
  const result = budgetStopStatusSchema.parse(response.json());
  expect(result.status).toBe('stopped');
  if (result.status !== 'stopped') throw new Error('Expected stopped');
  expect(result.reasons).toHaveLength(scope === 'both' ? 2 : 1);
  const now = new Date();
  const monthReset = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const dayReset = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  for (const reason of result.reasons) {
    const expectedReset = reason.period === 'daily' ? dayReset : monthReset;
    expect(reason).toEqual({ scope: scope === 'paying_group' || scope === 'assistant' ? scope : 'global',
      period: reason.period, cause: 'bound_refused', resetAt: expectedReset.toISOString(),
      remedy: 'ask_admin_or_wait', limitCents: 1 });
  }
  if (scope === 'daily') expect(result.reasons[0]!.period).toBe('daily');
  if (scope === 'both') expect(result.reasons.map(period)).toEqual(['monthly', 'daily']);
}
function period(reason: { period: string }) { return reason.period; }
it.each(scopes)('returns the saved %s reasons, reset and remedy', reasonsForScope);

async function hidesOtherScopes() {
  await start();
  for (const scope of ['paying_group', 'assistant']) {
    await setup.actor.configure({ scope, scopeId: 'other', ceilingCents: 0, setBy: 'alice' });
    await deliverLatest();
  }
  expect((await read()).json()).toEqual({ status: 'not_stopped' });
  for (const scope of ['paying_group', 'assistant']) {
    await setup.actor.configure({ scope, scopeId: 'other', ceilingCents: 1, setBy: 'alice' });
  }
  await setup.actor.configure({ scope: 'global', ceilingCents: 1, dailyCeilingCents: 2000,
    defaultPayingGroupId: 'personal-default', setBy: 'alice' });
  const call = { model: 'gpt-6-luna', priceTableId, computerId: 'other',
    assistantId: 'other', requesterId: 'alice', conversationId: 'other', turnId: 'other',
    threadId: 'other', payingGroupId: 'other', contextDigest: '0'.repeat(64) };
  await expect(setup.actor.reserve(call, 2)).rejects.toThrow('spending');
  await deliverLatest();
  const result = budgetStopStatusSchema.parse((await read()).json());
  expect(result).toMatchObject({ reasons: [{ scope: 'global' }] });
  if (result.status === 'stopped') expect(result.reasons).toHaveLength(1);
}
it('omits stops belonging to another payer or assistant', hidesOtherScopes);

async function hidesAmountsAndRefusesPrivateTurns() {
  for (const role of ['member', 'admin', 'owner']) await participant(role, role);
  const visible = await message();
  await stop();
  for (const role of ['member', 'admin', 'owner']) {
    const response = await read(visible, role);
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toMatch(/cents/iu);
    await participant(`outside-${role}`, role, false);
    expect((await read(visible, `outside-${role}`)).json()).toEqual({ status: 'refused' });
    expect((await read(visible, `outside-${role}`)).statusCode).toBe(403);
  }
  for (const [id, sub, org] of [[turnId, 'member', 'org-test'],
    ['unknown', 'alice', 'org-test'], [visible, 'alice', 'foreign-org']]) {
    const response = await read(id, sub, org);
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ status: 'refused' });
  }
  await remove('member');
  expect((await read(visible, 'member')).statusCode).toBe(403);
  const agent = await setup.append('conversation-conversation', 'message.posted', {
    conversationId: 'conversation', authorKind: 'agent', authorId: 'assistant',
    ciphertext: 'ZmFrZS1jaXBoZXJ0ZXh0', keyId: 'key:1', contentType: 'text' });
  expect((await read(agent.id)).statusCode).toBe(403);
}
it('limits cents to the author and refuses hidden turns regardless of role',
  hidesAmountsAndRefusesPrivateTurns);

async function reportsWork() {
  await start();
  await setup.append('conversation-other', 'conversation.created', {
    conversationId: 'other', assistantId: 'assistant', createdBy: 'alice', mode: 'agent_session' });
  await message('other');
  const queued = await message();
  const closedBefore = await message();
  await start(closedBefore);
  await finish(closedBefore);
  await stop();
  const response = await read();
  expect(response.json()).toMatchObject({ work: [
    { turnId, execution: 'stopping' }, { turnId: queued, execution: 'not_started' }] });
  expect((await read(closedBefore)).json()).toEqual({ status: 'not_stopped' });
  await finish();
  expect((await read()).json()).toMatchObject({ work: [
    { turnId, execution: 'ended' }, { turnId: queued, execution: 'not_started' }] });
}
it('distinguishes running, queued and ended work without changing an earlier close', reportsWork);

async function hidesWorkBeforeLateJoin() {
  const earlierTurn = turnId;
  await participant('late-member', 'member');
  const laterTurn = await message();
  const stopId = await stop();
  await setup.append('conversation-conversation', 'agent.turn_stop_requested', {
    conversationId: 'conversation', turnId: earlierTurn, reason: 'budget', stopId });
  await setup.append('conversation-conversation', 'agent.turn_stop_requested', {
    conversationId: 'conversation', turnId: laterTurn, reason: 'budget', stopId });

  const response = await read(laterTurn, 'late-member');
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ work: [{ turnId: laterTurn, execution: 'not_started' }] });
  expect(response.json<{ work: { turnId: string }[] }>().work.map(workTurnId))
    .not.toContain(earlierTurn);
}
function workTurnId(work: { turnId: string }) {
  return work.turnId;
}
it('hides saved Stop work from before a participant joined', hidesWorkBeforeLateJoin);

async function rejectsMalformedCallStatus() {
  await saveCall(callCases[2]!);
  await stopSavedCalls();
  const result = budgetStopStatusSchema.parse((await read()).json());
  if (result.status !== 'stopped') throw new Error('Expected stopped');
  const validCall = result.calls[0]!;
  const invalidCalls = [
    { ...validCall, reference: '' },
    { ...validCall, chargedCents: 1.5 },
    { ...validCall, chargedCents: -1 },
    { reference: validCall.reference, status: 'released', heldCents: 1 },
    { ...validCall, extra: true },
  ];
  for (const call of invalidCalls) {
    const candidate = { ...result, calls: [call] };
    expect(budgetStopStatusSchema.safeParse(candidate).success).toBe(false);
  }
}
it('rejects empty references, invalid cents, wrong status amounts and extra call fields',
  rejectsMalformedCallStatus);

async function includesChargedCentsForRequester() {
  const expected = await saveCall(callCases[2]!);
  await stopSavedCalls();
  const response = await read();
  expect(response.json<{ calls: unknown[] }>().calls).toEqual([expected]);
}
it('includes charged cents in the requester reply', includesChargedCentsForRequester);

async function routeRejectsStopWithoutTurnId() {
  const stopId = await stop();
  await setup.append('conversation-conversation', 'agent.turn_stop_requested', {
    conversationId: 'conversation', turnId, reason: 'budget', stopId });
  const original = setup.nats.store.readStream.bind(setup.nats.store);
  async function* missingTurnId(stream: string, from?: number, deadline?: number) {
    for await (const row of original(stream, from, deadline)) {
      if (stream === 'conversation-conversation' &&
          row.event.type === 'agent.turn_stop_requested') {
        yield { ...row, event: { ...row.event, data: {
          conversationId: 'conversation', reason: 'budget', stopId } } };
        continue;
      }
      yield row;
    }
  }
  vi.spyOn(setup.nats.store, 'readStream').mockImplementation(missingTurnId);

  const response = await read();
  expect(response.statusCode).toBe(503);
  expect(response.json()).toEqual({ status: 'unavailable' });
}
it('refuses a saved Stop row without a turn id through the HTTP route',
  routeRejectsStopWithoutTurnId);

async function closesWithoutRecord() {
  await start();
  await stop(false);
  expect((await read()).statusCode).toBe(503);
  await setup.append('computer-assistant', 'computer.lost', {
    assistantId: 'assistant', computerId: 'computer' });
  expect((await read()).json()).toMatchObject({ status: 'stopped', work: [] });
}
it('waits for the handler or a terminal result after the stop', closesWithoutRecord);

const failures = ['budget-test', 'computer-assistant', 'conversation-conversation',
  'unknown-stop'];
async function unavailable(subject: string) {
  await stop();
  if (subject === 'unknown-stop') {
    const next = await message();
    await setup.append('conversation-conversation', 'agent.turn_stop_requested', {
      conversationId: 'conversation', turnId: next, reason: 'budget', stopId: 'unknown' });
    turnId = next;
    const work = { conversationId: 'conversation', turnId, assistantId: 'assistant',
      payingGroupId: 'personal-default' };
    await expect(models.turnBudgetStopDetails(setup.nats.store, 'test', work, 0,
      performance.now() + 10_000, 'unknown')).rejects.toThrow('Saved stop unavailable');
  } else {
    const original = setup.nats.store.readStream.bind(setup.nats.store);
    async function* fail(stream: string, from?: number, deadline?: number) {
      if (stream === subject) throw new Error('Unusable saved data');
      yield* original(stream, from, deadline);
    }
    vi.spyOn(setup.nats.store, 'readStream').mockImplementation(fail);
  }
  const response = await read();
  expect(response.statusCode).toBe(503);
  expect(response.json()).toEqual({ status: 'unavailable' });
}
it.each(failures)('fails closed for %s', unavailable);

const outsiderFailures = ['computer read', 'missing saved stop'] as const;
async function refusesOutsiderBeforeReportingFailure(failure: typeof outsiderFailures[number]) {
  await stop();
  if (failure === 'missing saved stop') {
    turnId = await message();
    await setup.append('conversation-conversation', 'agent.turn_stop_requested', {
      conversationId: 'conversation', turnId, reason: 'budget', stopId: 'unknown' });
  } else {
    const original = setup.nats.store.readStream.bind(setup.nats.store);
    async function* failComputerRead(stream: string, from?: number, deadline?: number) {
      if (stream === 'computer-assistant') {
        throw new Error('Unusable saved data');
      }
      yield* original(stream, from, deadline);
    }
    vi.spyOn(setup.nats.store, 'readStream').mockImplementation(failComputerRead);
  }
  const unknown = await read('unknown', 'outsider');
  expect(unknown.statusCode).toBe(403);
  expect(unknown.json()).toEqual({ status: 'refused' });
  const existing = await read(turnId, 'outsider');
  expect(existing.statusCode).toBe(unknown.statusCode);
  expect(existing.body).toBe(unknown.body);
  expect(existing.headers['cache-control']).toBe('no-store');
  const authorised = await read();
  expect(authorised.statusCode).toBe(503);
  expect(authorised.json()).toEqual({ status: 'unavailable' });
}
it.each(outsiderFailures)('refuses an outsider equally for unknown turns and %s failures',
  refusesOutsiderBeforeReportingFailure);

async function slowRead(removal: boolean) {
  await stop();
  const original = setup.nats.store.readStream.bind(setup.nats.store);
  let delayed = false;
  async function* slow(subject: string, from?: number, deadline?: number) {
    if (subject === 'conversation-conversation' && !delayed) {
      delayed = true;
      expect(deadline! - performance.now()).toBeGreaterThan(2000);
      await delay(2100);
      if (removal) await remove();
    }
    yield* original(subject, from, deadline);
  }
  vi.spyOn(setup.nats.store, 'readStream').mockImplementation(slow);
  const response = await read();
  expect(response.statusCode).toBe(removal ? 403 : 200);
  if (removal) expect(response.json()).toEqual({ status: 'refused' });
}
it.each([false, true])('loads slow history before checking access (removal: %s)', slowRead);

async function readOnlyAndRestart() {
  const calls = [];
  for (const scenario of callCases.slice(0, 4)) calls.push(await saveCall(scenario));
  await stopSavedCalls();
  const before = await setup.nats.store.head();
  const append = vi.spyOn(setup.nats.store, 'append');
  const response = await read();
  expect(response.json()).toMatchObject({ calls });
  await app.close();
  const restartedChat = { silo: 'test', store: setup.nats.store, db: setup.db, keys: setup.keys,
    binding: setup.binding, feed: { memberId } };
  app = buildServer(config, { chat: restartedChat });
  expect((await read()).json()).toEqual(response.json());
  const fresh = await connectEventStore(setup.nats.env('command'));
  const chat = { silo: 'test', store: fresh.store, db: setup.db, keys: setup.keys,
    binding: setup.binding, feed: { memberId } };
  const second = buildServer(config, { chat });
  try {
    const request = { url: `/api/conversations/conversation/budget-stops?turnId=${turnId}`,
      headers: headers() };
    expect((await second.inject(request)).json()).toEqual(response.json());
    expect(append).not.toHaveBeenCalled();
    expect(await setup.nats.store.head()).toBe(before);
    expect(setup.received()).toBe(0);
    expect(response.body).not.toMatch(/configurationId|settled|reserved|attempted|personal-default/u);
    const result = budgetStopStatusSchema.parse(response.json());
    expect(result).toMatchObject({ positions: {
      conversation: await setup.nats.store.head('conversation-conversation'),
      computer: await setup.nats.store.head('computer-assistant'),
      budget: await setup.nats.store.head('budget-test') } });
    expect(budgetStopStatusSchema.safeParse({ ...result, settledCents: 1 }).success).toBe(false);
  } finally {
    await second.close();
    await fresh.close();
  }
}
it('reads without appending or calling upstream and agrees after a fresh connection', readOnlyAndRestart);

async function refusesSessionFirst() {
  const readStream = vi.spyOn(setup.nats.store, 'readStream');
  const url = `/api/conversations/conversation/budget-stops?turnId=${turnId}`;
  expect((await app.inject({ url })).statusCode).toBe(401);
  expect((await read(turnId, 'alice', 'foreign')).statusCode).toBe(403);
  setup.binding.silo = 'foreign';
  expect((await read()).statusCode).toBe(403);
  expect(readStream).not.toHaveBeenCalled();
}
it('refuses missing, foreign organisation and foreign silo sessions before loading', refusesSessionFirst);

interface CallCase {
  name: string;
  status: 'held' | 'released' | 'charged' | 'possibly_sent';
  dispatch?: boolean;
  expired?: boolean;
  outcome?: 'unknown' | 'not_dispatched';
  charge?: number;
  free?: boolean;
}
const callCases: CallCase[] = [
  { name: 'unknown settlement with expiry', status: 'possibly_sent', outcome: 'unknown',
    charge: 0, dispatch: true, expired: true },
  { name: 'confirmed non-dispatch with expiry', status: 'released',
    outcome: 'not_dispatched', charge: 0, dispatch: true, expired: true },
  { name: 'settlement with dispatch and expiry', status: 'charged',
    charge: 3, dispatch: true, expired: true },
  { name: 'open reservation', status: 'held' },
  { name: 'admitted dispatch', status: 'possibly_sent', dispatch: true },
  { name: 'expiry after dispatch', status: 'possibly_sent', dispatch: true, expired: true },
  { name: 'expiry without dispatch', status: 'released', expired: true },
  { name: 'zero-cent charge', status: 'charged', charge: 0 },
  { name: 'free dispatch', status: 'possibly_sent', free: true },
];
async function saveCall(scenario: CallCase, conversationId = 'conversation', id = turnId) {
  const reference = crypto.randomUUID();
  const modelCall = { model: scenario.free ? 'mcp-zero-cost' : 'gpt-6-luna', priceTableId,
    computerId: 'computer', assistantId: 'assistant', requesterId: 'alice', conversationId,
    turnId: id, threadId: id, payingGroupId: 'personal-default', contextDigest: '0'.repeat(64) };
  if (!scenario.free) {
    await setup.append('budget-test', 'budget.reserved', { reservationId: reference,
      permitId: reference, amountCents: 7, payingGroupId: 'personal-default',
      assistantId: 'assistant', modelCall });
  }
  if (scenario.dispatch || scenario.free) {
    const dispatch = { callId: crypto.randomUUID(), decisionId: 'decision',
      bodyDigest: '0'.repeat(64), modelCall,
      ...(scenario.free ? { callId: reference } : { reservationId: reference }) };
    await setup.append('budget-test', 'budget.call_dispatch_admitted', dispatch);
  }
  if (scenario.expired) {
    await setup.append('budget-test', 'budget.reservation_expired', { reservationId: reference });
  }
  if (scenario.charge !== undefined) {
    await setup.append('budget-test', 'budget.settled', { reservationId: reference,
      permitId: reference, settledCents: scenario.charge, outcome: scenario.outcome });
  }
  const result = { reference, status: scenario.status };
  if (scenario.status === 'charged') return { ...result, chargedCents: scenario.charge };
  if (scenario.status === 'held' || scenario.status === 'possibly_sent') {
    return { ...result, heldCents: scenario.free ? 0 : 7 };
  }
  return result;
}
async function stopSavedCalls() {
  // Reload the writer after seeding events outside its command queue.
  await setup.restartActor();
  return stop();
}
async function reportsCall(scenario: CallCase) {
  const expected = await saveCall(scenario);
  await stopSavedCalls();
  const response = await read();
  expect(response.statusCode).toBe(200);
  expect(response.json<{ calls: unknown[] }>().calls).toEqual([expected]);
  expect(budgetStopStatusSchema.safeParse(response.json()).success).toBe(true);
  const extra = { ...response.json<Record<string, unknown>>(), calls: [{ ...expected, unexpected: true }] };
  expect(budgetStopStatusSchema.safeParse(extra).success).toBe(false);
}
it.each(callCases)('reports $name', reportsCall);

async function isolatesCalls() {
  await participant('bob', 'member');
  turnId = await message();
  const calls = [];
  for (const scenario of [callCases[0]!, callCases[8]!, ...callCases.slice(1, 4)]) {
    calls.push(await saveCall(scenario));
    await saveCall(scenario, 'other', turnId);
    await saveCall(scenario, 'conversation', 'other-turn');
  }
  await stopSavedCalls();
  expect((await read()).json<{ calls: unknown[] }>().calls).toEqual(calls);
  function withoutCents(call: { reference: string; status: string }) {
    return { reference: call.reference, status: call.status };
  }
  const response = await read(turnId, 'bob');
  expect(response.statusCode).toBe(200);
  expect(response.json<{ calls: unknown[] }>().calls).toEqual(calls.map(withoutCents));
  expect(response.body).not.toMatch(/cents/iu);
}
it('keeps saved call order, joins dispatches once and limits calls and cents to their turn',
  isolatesCalls);

async function manualStopIsNotBudgetStop() {
  await setup.append('conversation-conversation', 'agent.turn_stop_requested', {
    conversationId: 'conversation', turnId, requestedBy: 'alice' });
  expect((await read()).json()).toEqual({ status: 'not_stopped' });
}
it('does not select a manual stop as the saved spending Stop', manualStopIsNotBudgetStop);

async function earliestEnd() {
  await start();
  await finish();
  await stop(false);
  await setup.append('conversation-conversation', 'agent.turn_failed', {
    conversationId: 'conversation', turnId, reason: 'computer_lost' });
  expect((await read()).json()).toEqual({ status: 'not_stopped' });
}
it('uses the earlier computer close even when the chat fails after the Stop', earliestEnd);

async function separateStops() {
  const firstTurn = turnId;
  const firstStop = await stop();
  await setup.actor.configure({ scope: 'paying_group', scopeId: 'personal-default',
    ceilingCents: 100, setBy: 'alice' });
  turnId = await message();
  const secondStop = await stop();
  const duplicate = { conversationId: 'conversation', turnId, reason: 'budget', stopId: secondStop };
  expect(agentTurnStopRequestedDataSchema.safeParse({ ...duplicate, turnId: undefined }).success)
    .toBe(false);
  await setup.append('conversation-conversation', 'agent.turn_stop_requested', duplicate);
  expect((await read(firstTurn)).json()).toMatchObject({ stopId: firstStop,
    work: [{ turnId: firstTurn, execution: 'not_started' }] });
  expect((await read()).json()).toMatchObject({ stopId: secondStop,
    work: [{ turnId, execution: 'not_started' }] });
}
it('keeps each Stop work list separate and lists a redelivered turn once', separateStops);

async function refusesWrongStart() {
  await stop();
  await setup.append('computer-assistant', 'computer.turn_started', {
    assistantId: 'assistant', computerId: 'computer', conversationId: 'other', turnId,
    threadId: turnId, requesterId: 'alice', task: 'chat_turn', payingGroupId: 'personal-default' });
  const response = await read();
  expect(response.statusCode).toBe(503);
  expect(response.json()).toEqual({ status: 'unavailable' });
}
it('refuses a saved start naming another conversation', refusesWrongStart);

async function totalDeadline() {
  const original = setup.nats.store.readStream.bind(setup.nats.store);
  const now = performance.now.bind(performance);
  let elapsed = 0;
  let loading = true;
  function time() { return now() + elapsed; }
  async function* slow(stream: string, from?: number, deadline?: number) {
    yield* original(stream, from, deadline);
    if (loading && (stream === 'conversation-conversation' || stream === 'computer-assistant')) {
      elapsed += 3400;
    }
  }
  const details = models.turnBudgetStopDetails;
  async function timedDetails(...args: Parameters<typeof details>) {
    const result = await details(...args);
    elapsed += 3400;
    loading = false;
    return result;
  }
  vi.spyOn(models, 'turnBudgetStopDetails').mockImplementation(timedDetails);
  vi.spyOn(performance, 'now').mockImplementation(time);
  vi.spyOn(setup.nats.store, 'readStream').mockImplementation(slow);
  const response = await read();
  expect(response.statusCode).toBe(503);
  expect(response.json()).toEqual({ status: 'unavailable' });
}
it('refuses a total history read past ten seconds even when individual reads finish', totalDeadline);

async function pendingAccess() {
  await participant('bob', 'member', false);
  await setup.append('participation-conversation', 'participant.added', {
    conversationId: 'conversation', participantId: 'bob', addedBy: 'alice' });
  turnId = await message();
  await stop();
  const response = await read(turnId, 'bob');
  expect(response.statusCode).toBe(425);
  expect(response.json()).toEqual({ status: 'access_applying' });
}
it('withholds Stop data while access is still applying', pendingAccess);

async function roleLoss() {
  await stop();
  const changed = await setup.append('member-alice', 'member.role_changed', {
    memberId: 'alice', previousRole: 'owner', newRole: 'member', changedBy: 'alice' });
  await setup.auth.handler.handle(changed, setup.db);
  const removed = await setup.append('member-alice', 'member.removed', {
    memberId: 'alice', removedBy: 'alice' });
  await setup.auth.handler.handle(removed, setup.db);
  const response = await read();
  expect(response.statusCode).toBe(403);
  expect(response.json()).toEqual({ status: 'refused' });
}
it('refuses a former owner after losing silo membership', roleLoss);
