import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { jetstream, jetstreamManager } from '@nats-io/jetstream';
import { EventStore } from '@opencrane/event-store';
import { natsFixture, TimeoutError } from '@opencrane/event-store/testing';
import { BudgetActor, envelope, history, priceTableId, totals } from '../src/index.ts';
import { applyBudget } from '../src/state.ts';
import { takeRefusedAdmission } from '../src/budget-writer.ts';
import { CeilingReceiptRecovery } from '../src/ceiling-receipt-recovery.ts';

let nats: Awaited<ReturnType<typeof natsFixture>>;
let actor: BudgetActor;
let client: ReturnType<typeof jetstream>;
let store: EventStore;
const call = { requestId: 'call', model: 'gpt-6-luna', priceTableId,
  computerId: 'computer', assistantId: 'assistant', requesterId: 'alice',
  conversationId: 'conversation', turnId: 'turn', threadId: 'thread', payingGroupId: 'group',
  contextDigest: '0'.repeat(64) };
async function setup() {
  nats = await natsFixture();
  client = jetstream(nats.connection);
  const manager = await jetstreamManager(nats.connection);
  store = new EventStore(client, manager);
  actor = new BudgetActor(store, 'test');
  await actor.start(100, 100, 'group');
}
async function close() {
  vi.restoreAllMocks();
  await nats.close();
}
function fresh() { return Promise.resolve(); }
beforeEach(setup);
afterEach(close);

async function lostAdmission(delayed: boolean) {
  const reservationId = await actor.reserve(call, 10);
  const admission = { reservationId, callId: 'call', decisionId: 'decision',
    bodyDigest: '0'.repeat(64), modelCall: call };
  const publish = client.publish.bind(client);
  let pending: Parameters<typeof publish> | undefined;
  const deadline = performance.now() + 2000;
  const clock = vi.spyOn(performance, 'now');
  async function loseReply(...args: Parameters<typeof publish>): Promise<never> {
    pending = args;
    if (!delayed) await publish(...args);
    clock.mockReturnValue(deadline);
    throw new TimeoutError();
  }
  client.publish = loseReply;
  function checked() { return fresh(); }
  checked.deadline = deadline;
  await expect(actor.admitDispatch(admission, checked)).rejects.toThrow('unavailable');
  expect(pending).toBeDefined();
  clock.mockRestore();
  client.publish = publish;
  await expect(actor.requireCurrent(performance.now() + 2000)).rejects.toThrow('unavailable');
  async function* failedRead(): AsyncGenerator<never> { yield await Promise.reject(new TimeoutError()); }
  const reads = vi.spyOn(store, 'readStream').mockImplementationOnce(failedRead);
  await expect(actor.reserve(call, 1)).rejects.toThrow();
  expect(reads).toHaveBeenCalled();
  reads.mockRestore();
  if (delayed) {
    await expect(actor.reserve(call, 1)).rejects.toThrow('unavailable');
    await expect(actor.releaseUndispatched(reservationId)).rejects.toThrow('unavailable');
    await publish(...pending!);
  }
  await actor.reserve({ ...call, requestId: 'next' }, 1);
  await expect(actor.admitDispatch(admission, fresh)).rejects.toThrow();
  expect(actor.state.dispatches).toHaveLength(1);
  expect(totals(actor.state)).toMatchObject({ reservedCents: 11, monthCents: 0 });
  const rows = await history(store, 'budget-test', 'test');
  function admitted(row: typeof rows[number]) {
    return row.event.type === 'budget.call_dispatch_admitted';
  }
  expect(rows.filter(admitted)).toHaveLength(1);
  const replacement = new BudgetActor(store, 'test');
  await replacement.start();
  expect(replacement.state.dispatches).toHaveLength(1);
  expect(totals(replacement.state)).toMatchObject({ reservedCents: 11, monthCents: 0 });
}
it.each([false, true])('recovers its own admission without resending (delayed: %s)', lostAdmission);

async function failedConflictRead() {
  let checks = 0;
  async function checked() {
    checks += 1;
    if (checks !== 2) return;
    const data = { memberId: 'other', email: 'other@example.test', displayName: 'Other', role: 'member' };
    const event = envelope('test', 'member-other', 'member.joined', data);
    await nats.store.append({ event, expectedSequence: 0 });
  }
  async function* failedRead(): AsyncGenerator<never> { yield await Promise.reject(new TimeoutError()); }
  const reads = vi.spyOn(store, 'readStream').mockImplementationOnce(failedRead);
  await expect(actor.reserve(call, 10, checked)).rejects.toThrow('unavailable');
  expect(checks).toBe(2);
  expect(reads).toHaveBeenCalledTimes(1);
  expect(actor.state.reservations).toHaveLength(0);
  await expect(actor.requireCurrent(performance.now() + 2000)).rejects.toThrow('unavailable');
  reads.mockImplementationOnce(failedRead);
  await expect(actor.reserve(call, 1)).rejects.toThrow();
  reads.mockRestore();
  await actor.reserve(call, 1);
  expect(totals(actor.state).reservedCents).toBe(1);
}
it('recovers after a confirmed rejection and repeated read failures', failedConflictRead);

async function applicationFailure() {
  const before = actor.state.sequence;
  const folding = vi.spyOn(CeilingReceiptRecovery.prototype, 'apply');
  let injected = false;
  function failAfterApplying(...args: Parameters<CeilingReceiptRecovery['apply']>) {
    const [event, sequence, state] = args;
    applyBudget(state, event, sequence);
    injected = true;
    throw new Error('Fold failed');
  }
  folding.mockImplementationOnce(failAfterApplying);
  await expect(actor.reserve(call, 10)).rejects.toThrow('Fold failed');
  expect(injected).toBe(true);
  expect(actor.state.sequence).toBe(before);
  expect(totals(actor.state).reservedCents).toBe(0);
  await expect(actor.requireCurrent(performance.now() + 2000)).rejects.toThrow('unavailable');
  await actor.reserve(call, 1);
  expect(totals(actor.state).reservedCents).toBe(11);
  expect(actor.state.reservations).toHaveLength(2);
}
it('rebuilds failed application before another money decision', applicationFailure);

async function savedPayload() {
  const publish = client.publish.bind(client);
  let injected = false;
  async function saveOriginal(...args: Parameters<typeof publish>) {
    if (!injected) {
      injected = true;
      const event = envelope('test', 'budget-test', 'budget.ceiling_set',
        { scope: 'global', ceilingCents: 150, setBy: 'owner' }, 'same-command');
      await publish(args[0], JSON.stringify(event), args[2]);
    }
    return publish(...args);
  }
  client.publish = saveOriginal;
  const result = await actor.configure({ scope: 'global', ceilingCents: 200, setBy: 'owner' },
    'same-command');
  expect(injected).toBe(true);
  expect(result).toMatchObject({ status: 'appended', receipt: { ceilingCents: 150 } });
  expect(actor.state.ceilingCents).toBe(150);
  await actor.reserve(call, 1);
  expect(totals(actor.state).reservedCents).toBe(1);
}
it('applies the exact saved payload after a duplicate acknowledgement', savedPayload);

async function duplicateAfterReplacement() {
  const payload = { scope: 'global', ceilingCents: 100, setBy: 'alice' };
  const revision = actor.state.sequence;
  const replacementCall = { ...call, requestId: 'replacement-call' };
  let checks = 0;
  async function checked() {
    checks += 1;
    if (checks !== 2) return;
    const replacement = new BudgetActor(nats.store, 'test');
    await replacement.start();
    const reservationId = await replacement.reserve(replacementCall, 90);
    const admission = { reservationId, callId: 'replacement-call',
      decisionId: 'replacement-decision', bodyDigest: '0'.repeat(64),
      modelCall: replacementCall };
    await replacement.admitDispatch(admission, fresh);
    const saved = await replacement.configure(payload, 'overlapping-configuration');
    expect(saved.status).toBe('appended');
  }
  checked.deadline = performance.now() + 2000;
  const configuring = actor.configure(payload, 'overlapping-configuration', revision, checked);
  await expect(configuring).rejects.toThrow('Budget writer lost its fence');
  expect(checks).toBe(2);
  expect(actor.state.sequence).toBe(revision);
  const staleCall = { ...call, requestId: 'stale-call' };
  await expect(actor.reserve(staleCall, 20)).rejects.toThrow('Budget writer unavailable');
  await expect(actor.requireCurrent(performance.now() + 2000))
    .rejects.toThrow('Budget writer unavailable');
  const rows = await history(store, 'budget-test', 'test');
  function isReservation(row: typeof rows[number]) {
    return row.event.type === 'budget.reserved';
  }
  expect(rows.filter(isReservation)).toHaveLength(1);
  const replay = new BudgetActor(nats.store, 'test');
  await replay.start();
  expect(replay.state.reservations).toHaveLength(1);
  expect(replay.state.dispatches).toHaveLength(1);
  expect(totals(replay.state)).toMatchObject({ reservedCents: 90, monthCents: 0 });
  await expect(replay.reserve(staleCall, 20)).rejects.toThrow();
  expect(totals(replay.state).reservedCents).toBe(90);
}
it('stops on replacement writes before accepting their duplicate receipt',
  duplicateAfterReplacement);

async function concurrentConfigurationReceipt(change: 'none' | 'amount' | 'administrator') {
  const read = store.readStream.bind(store);
  const bothRead = Promise.withResolvers<void>();
  let reads = 0;
  async function* barrier(...args: Parameters<typeof read>) {
    const rows = [];
    for await (const row of read(...args)) rows.push(row);
    reads += 1;
    if (reads === 2) bothRead.resolve();
    if (reads <= 2) await bothRead.promise;
    for (const row of rows) yield row;
  }
  const reading = vi.spyOn(store, 'readStream');
  reading.mockImplementation(barrier);
  const publishing = Promise.withResolvers<void>();
  const retryPrepared = Promise.withResolvers<void>();
  const publish = client.publish.bind(client);
  async function holdFirstPublish(...args: Parameters<typeof publish>) {
    publishing.resolve();
    await retryPrepared.promise;
    return publish(...args);
  }
  client.publish = holdFirstPublish;
  async function retryAccess() {
    await publishing.promise;
    retryPrepared.resolve();
  }
  const payload = { scope: 'global', ceilingCents: 150, setBy: 'alice' };
  const retryPayload = { ...payload };
  if (change === 'amount') retryPayload.ceilingCents = 200;
  if (change === 'administrator') retryPayload.setBy = 'bob';
  const revision = actor.state.sequence;
  const first = actor.configure(payload, 'concurrent-config', revision);
  const retry = actor.configure(retryPayload, 'concurrent-config', revision, retryAccess);
  const results = await Promise.all([first, retry]);
  expect(results[0]).toMatchObject({ status: 'appended' });
  if (change === 'none') {
    expect(results[1]).toEqual(results[0]);
  } else {
    expect(results[1]).toEqual({ status: 'conflict' });
  }
  expect(actor.state.ceilingCents).toBe(150);
  function isCommand(row: Awaited<ReturnType<typeof history>>[number]) {
    return row.event.commandId === 'concurrent-config';
  }
  const rows = await history(store, 'budget-test', 'test');
  expect(rows.filter(isCommand)).toHaveLength(1);
  await actor.reserve(call, 1);
  expect(totals(actor.state).reservedCents).toBe(1);
}
it.each(['none', 'amount', 'administrator'] as const)(
  'returns the original concurrent configuration receipt only for identical input (change: %s)',
  concurrentConfigurationReceipt);

async function queuedExpiry() {
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  function waiting() {
    entered.resolve();
    return released.promise;
  }
  const first = actor.reserve(call, 1, waiting);
  await entered.promise;
  function checked() { return Promise.resolve(); }
  checked.deadline = performance.now() + 20;
  try {
    await expect(actor.reserve(call, 10, checked)).rejects.toThrow('unavailable');
    await expect(actor.requireCurrent(performance.now() + 20)).rejects.toThrow('unavailable');
    expect(actor.state.reservations).toHaveLength(0);
  } finally {
    released.resolve();
  }
  await first;
  await actor.reserve(call, 1);
  expect(totals(actor.state).reservedCents).toBe(2);
}
it('refuses expired queue waits before the earlier command finishes', queuedExpiry);

async function lateAcknowledgement() {
  const publish = client.publish.bind(client);
  const deadline = performance.now() + 2000;
  const clock = vi.spyOn(performance, 'now');
  let injected = false;
  async function lateReply(...args: Parameters<typeof publish>) {
    const result = await publish(...args);
    injected = true;
    clock.mockReturnValue(deadline);
    return result;
  }
  function checked() { return Promise.resolve(); }
  checked.deadline = deadline;
  client.publish = lateReply;
  await expect(actor.reserve(call, 10, checked)).rejects.toThrow('unavailable');
  expect(injected).toBe(true);
  clock.mockRestore();
  client.publish = publish;
  expect(totals(actor.state).reservedCents).toBe(10);
  await actor.reserve(call, 1);
  expect(totals(actor.state).reservedCents).toBe(11);
}
it('keeps a late saved hold without returning late permission', lateAcknowledgement);

async function foreignSwitch(field: 'silo' | 'subject') {
  const payload = { providerId: 'primary', revision: 1, changedBy: 'alice',
    expectedProviderSequence: 0 };
  const marker = envelope('test', 'budget-test', 'provider.managed_calls_enabled', payload);
  const position = await store.head('budget-test');
  await nats.store.append({ event: marker, expectedSequence: position });
  const read = store.readStream.bind(store);
  let injected = false;
  async function* foreignRows(...args: Parameters<typeof read>) {
    for await (const row of read(...args)) {
      injected = true;
      yield { ...row, event: { ...row.event, [field]: 'other' } };
    }
  }
  const reading = vi.spyOn(store, 'readStream').mockImplementation(foreignRows);
  await expect(actor.reserve(call, 1)).rejects.toThrow('recovery mismatch');
  expect(injected).toBe(true);
  await expect(actor.requireCurrent(performance.now() + 2000)).rejects.toThrow('unavailable');
  reading.mockRestore();
  const ceiling = { scope: 'global', ceilingCents: 120, setBy: 'owner' };
  expect((await actor.configure(ceiling)).status).toBe('appended');
  expect(totals(actor.state).reservedCents).toBe(0);
}
it.each(['silo', 'subject'] as const)('refuses recovery rows from another %s', foreignSwitch);

async function savedRefusalEvidence() {
  const reservationId = await actor.reserve(call, 10);
  const admission = { reservationId, callId: 'call', decisionId: 'decision',
    bodyDigest: '0'.repeat(64), modelCall: call };
  const refused = new Error('Access changed after saving');
  function checked() {
    if (actor.state.dispatches.length > 0) return Promise.reject(refused);
    return Promise.resolve();
  }
  await expect(actor.admitDispatch(admission, checked)).rejects.toBe(refused);
  expect(takeRefusedAdmission(refused)).toMatchObject({
    type: 'budget.call_dispatch_admitted', data: admission });
  expect(takeRefusedAdmission(refused)).toBeUndefined();
  expect(takeRefusedAdmission(new Error('Generic refusal'))).toBeUndefined();
  function retainError(error: unknown) { return error; }
  const duplicate = await actor.admitDispatch(admission, fresh).catch(retainError);
  expect(duplicate).toBeInstanceOf(Error);
  expect(takeRefusedAdmission(duplicate)).toBeUndefined();
  expect(actor.state.dispatches).toHaveLength(1);
  expect(totals(actor.state).reservedCents).toBe(10);
}
it('binds refused admission evidence to one failed invocation', savedRefusalEvidence);
