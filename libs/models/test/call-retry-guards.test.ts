import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { natsFixture } from '@opencrane/event-store/testing';
import { BudgetActor, envelope, priceTableId } from '../src/index.ts';
import { grantModelCall, refuseCallRetry } from '../src/call-retry.ts';
import { CallRetryRefused, retryReservation } from '../src/root-budget.ts';

let nats: Awaited<ReturnType<typeof natsFixture>>;
let actor: BudgetActor;
const binding = { requesterId: 'alice', conversationId: 'conversation', turnId: 'turn',
  threadId: 'thread', assistantId: 'assistant', computerId: 'computer', generation: 1,
  payingGroupId: 'group', allowanceCents: 1000 };
const call = { requesterId: 'alice', conversationId: 'conversation', turnId: 'turn',
  threadId: 'thread', assistantId: 'assistant', computerId: 'computer', generation: 1,
  payingGroupId: 'group', model: 'gpt-6-luna', priceTableId,
  contextDigest: '0'.repeat(64), requestId: 'original' };
const retry = { retryDigest: '1'.repeat(64), bodyDigest: '2'.repeat(64) };
async function fresh() {}
function noEvidence() {
  return Promise.resolve(false);
}
async function setup() {
  nats = await natsFixture();
  actor = new BudgetActor(nats.store, 'test');
  await actor.start(10_000, 10_000, 'group');
  await actor.setRootAllowance(binding, 1);
}
async function close() {
  vi.restoreAllMocks();
  await nats.close();
}
beforeEach(setup);
afterEach(close);

async function savedHold() {
  const rootId = actor.state.roots[0]!.rootId;
  await actor.reserve(call, 10, fresh, undefined, rootId, retry);
  return actor.state.reservations[0]!;
}
async function changedRetry(field: string) {
  const saved = await savedHold();
  const changedCall = { ...call };
  const changedRetry = { ...retry };
  let rootId: string | undefined = saved.rootId;
  let amount = saved.amountCents;
  if (field === 'missing root') {
    rootId = undefined;
    Reflect.deleteProperty(saved, 'rootId');
  } else if (field === 'root') {
    rootId = 'other';
  } else if (field === 'body') {
    changedRetry.bodyDigest = '3'.repeat(64);
  } else if (field === 'amount') {
    amount++;
  } else if (field === 'missing request') {
    Reflect.deleteProperty(changedCall, 'requestId');
  } else if (field === 'settled') {
    saved.settledCents = 0;
  } else if (field === 'expired') {
    saved.expired = true;
  } else if (field === 'unknown') {
    saved.outcomeUnknown = true;
  } else if (field === 'generation') {
    changedCall.generation++;
  } else if (field === 'bindingSequence') {
    Object.assign(changedCall, { bindingSequence: 42 });
  } else {
    Reflect.set(changedCall, field, 'changed');
  }
  const before = await nats.store.head();
  await expect(retryReservation(actor.state, changedCall, amount, rootId,
    changedRetry, noEvidence, fresh)).rejects.toThrow('Model call retry refused');
  expect(await nats.store.head()).toBe(before);
}
it.each(['missing root', 'missing request', 'root', 'body', 'amount', 'settled', 'expired',
  'unknown', 'model', 'computerId', 'generation', 'assistantId', 'requesterId',
  'conversationId', 'turnId', 'threadId', 'providerId', 'bindingSequence'])(
  'refuses changed retry %s before later admission checks', changedRetry);

function failedAllow(): Promise<string> {
  return Promise.reject(new Error('private key, root and amount must never escape'));
}
async function missingDecision() {
  const admission = vi.spyOn(actor, 'admitDispatch');
  admission.mockResolvedValue();
  await expect(grantModelCall(actor, call, 10, 'body', fresh, 1, failedAllow))
    .rejects.toThrow(/^Model call retry refused$/u);
  expect(actor.state.reservations).toHaveLength(1);
  expect(actor.state.reservations[0]?.settledCents).toBeUndefined();
  expect(actor.state.dispatches).toHaveLength(0);
  expect(admission).not.toHaveBeenCalled();
}
it('keeps an unsent hold when the decision write fails without a saved decision', missingDecision);

async function changedDecision(field: string) {
  await missingDecision();
  const saved = actor.state.reservations[0]!;
  const payload = { requestId: saved.call.requestId, route: 'model', outcome: 'allow',
    reason: 'model_allowed', contextDigest: saved.call.contextDigest, permitId: saved.id };
  const event = envelope('test', `decision-${saved.call.requestId}`, 'decision.recorded', payload);
  if (field === 'type') {
    event.type = 'security.alert_raised';
  } else if (field !== 'count') {
    event.data = { ...payload, [field]: 'changed' };
  }
  // Supply damaged saved history directly so each recovery guard is tested on its own.
  const row = { event, sequence: 1 };
  async function* readDecision() {
    yield await Promise.resolve(row);
    if (field === 'count') {
      yield row;
    }
  }
  const reader = vi.spyOn(nats.store, 'readStream');
  reader.mockImplementation(readDecision);
  const reserve = vi.spyOn(actor, 'reserve');
  reserve.mockResolvedValue(saved.id);
  const admission = vi.spyOn(actor, 'admitDispatch');
  admission.mockResolvedValue();
  await expect(grantModelCall(actor, call, 10, 'body', fresh, 1, failedAllow))
    .rejects.toThrow(/^Model call retry refused$/u);
  expect(admission).not.toHaveBeenCalled();
}
it.each(['count', 'type', 'outcome', 'requestId', 'permitId', 'contextDigest'])(
  'refuses a saved decision with changed %s', changedDecision);

async function changedDigest(field: string) {
  const reserve = vi.spyOn(actor, 'reserve');
  reserve.mockRejectedValue(new Error('stop before writing'));
  await expect(grantModelCall(actor, call, 10, 'body', fresh, 1, failedAllow)).rejects.toThrow();
  const initial = reserve.mock.calls[0]![5]!;
  const changedCall = { ...call };
  let body = 'body';
  if (field === 'silo') {
    Reflect.set(actor, 'silo', 'other');
  } else if (field === 'root') {
    actor.state.roots[0]!.rootId = '3'.repeat(64);
  } else if (field === 'body') {
    body = 'other';
  } else if (field === 'generation') {
    changedCall.generation++;
  } else {
    Reflect.set(changedCall, field, 'other');
  }
  if (field === 'conversationId' || field === 'turnId') {
    Reflect.set(actor.state.roots[0]!, field, 'other');
  }
  await expect(grantModelCall(actor, changedCall, 10, body, fresh, 1, failedAllow))
    .rejects.toThrow();
  const changed = reserve.mock.calls[1]![5]!;
  expect(changed.retryDigest).not.toBe(initial.retryDigest);
}
it.each(['silo', 'root', 'computerId', 'generation', 'conversationId', 'turnId',
  'threadId', 'body'])('binds retry identity to %s individually', changedDigest);

async function refusesRelease(kind: 'effect' | 'security') {
  const saved = await savedHold();
  let payload: Record<string, unknown> = { permitId: saved.id, computerId: 'computer',
    tool: 'gpt-6-luna', destination: 'openai', outcome: 'success', costCents: 1 };
  let type = 'effect.observed';
  if (kind === 'security') {
    type = 'security.alert_raised';
    payload = { alertId: 'alert', severity: 'high', reason: 'effect_without_permit' };
  }
  const event = envelope('test', `${kind}-${saved.id}`, type, payload);
  await nats.seed([event]);
  const before = await nats.store.head();
  await expect(actor.releaseUndispatched(saved.id)).rejects.toThrow('Call may have been dispatched');
  expect(await nats.store.head()).toBe(before);
  expect(saved.settledCents).toBeUndefined();
}
it.each(['effect', 'security'] as const)('keeps the hold with %s evidence during zero release',
  refusesRelease);

async function recoveredCeiling() {
  const saved = await savedHold();
  await actor.configure({ scope: 'global', dailyCeilingCents: 0, ceilingCents: 0,
    setBy: 'owner' });
  await expect(actor.reserve(call, 10, fresh, undefined, saved.rootId, retry))
    .rejects.toMatchObject({ reason: 'ceiling_stop' });
  expect(actor.state.roots[0]?.stop?.reason).toBe('ceiling_stop');
  expect(actor.state.reservations).toHaveLength(1);
  expect(saved.settledCents).toBeUndefined();
  expect(actor.state.dispatches).toHaveLength(0);
}
it('refuses a recovered grant after its spending ceiling stops work', recoveredCeiling);

async function stopsDuringAccessRefresh() {
  const saved = await savedHold();
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  async function pausedAccess() {
    entered.resolve();
    await released.promise;
  }
  const dispatch = { callId: call.requestId, decisionId: 'decision',
    bodyDigest: saved.bodyDigest!, reservationId: saved.id, modelCall: saved.call,
    rootId: saved.rootId! };
  const admission = actor.admitDispatch(dispatch, pausedAccess);
  const refused = expect(admission).rejects.toThrow('Root budget refused');
  await entered.promise;
  // Model replay updating the root while the access check is waiting.
  actor.state.roots[0]!.stop = { rootId: saved.rootId!, reason: 'requester_stop',
    sourceSubject: 'conversation-conversation', sourcePosition: 1, sourceEventId: 'stop' };
  released.resolve();
  await refused;
  expect(saved.settledCents).toBe(0);
  expect(actor.state.dispatches).toHaveLength(0);
}
it('checks root Stop after the paused access refresh during admission', stopsDuringAccessRefresh);

async function refusesAdmittedGrant() {
  const saved = await savedHold();
  const dispatch = { callId: call.requestId, decisionId: 'decision',
    bodyDigest: saved.bodyDigest!, reservationId: saved.id, modelCall: saved.call,
    rootId: saved.rootId! };
  await actor.admitDispatch(dispatch, fresh);
  const before = await nats.store.head();
  await expect(actor.reserve(call, 10, fresh, undefined, saved.rootId, retry))
    .rejects.toThrow('Model call retry refused');
  expect(await nats.store.head()).toBe(before);
  expect(saved.settledCents).toBeUndefined();
}
it('refuses an admitted hold at retry grant before another admission check', refusesAdmittedGrant);

async function refusesProviderRelease() {
  const verificationCall = { ...call, assistantId: 'provider-verification',
    computerId: 'provider-primary', turnId: 'verification' };
  const reservationId = await actor.reserve(verificationCall, 10);
  const payload = { providerId: 'primary', revision: 1, changedBy: 'owner',
    attemptId: 'verification', kind: 'model', model: 'gpt-6-luna', reservationId };
  const event = envelope('test', 'provider-primary', 'provider.verification_dispatched', payload);
  await nats.seed([event]);
  const before = await nats.store.head();
  await expect(actor.releaseUndispatched(reservationId))
    .rejects.toThrow('Call may have been dispatched');
  expect(await nats.store.head()).toBe(before);
  expect(actor.state.reservations[0]?.settledCents).toBeUndefined();
}
it('keeps a provider hold with dispatch evidence during zero release', refusesProviderRelease);

function redactsRetryResponse(auditAttempted: boolean) {
  const response = new ServerResponse(new IncomingMessage(new Socket()));
  const write = vi.spyOn(response, 'writeHead');
  write.mockReturnValue(response);
  const end = vi.spyOn(response, 'end');
  end.mockReturnValue(response);
  const error = new CallRetryRefused();
  error.cause = { rootId: 'private-root', key: 'private-key', cents: 1000,
    digest: 'a'.repeat(64) };
  expect(refuseCallRetry(error, response, auditAttempted)).toBe(true);
  expect(write).toHaveBeenCalledWith(auditAttempted ? 503 : 403);
  expect(end).toHaveBeenCalledWith('{"error":"Model call retry refused"}');
}
it.each([false, true])('returns only fixed retry refusal text; audit attempted=%s',
  redactsRetryResponse);
