import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { memoryContextRecordedEventSchema } from '@opencrane/events';
import { natsFixture } from '@opencrane/event-store/testing';
import { createEventStore } from '@opencrane/event-store';
import { history } from '@opencrane/models';
import { memoryJourney } from '../../../scripts/private-memory-qualification/memory-journey.ts';
import { invalidateMemoryContext } from '../src/memory/invalidation.ts';
import { readChatFacts } from '../src/chat/chat-summary.ts';

let setup: Awaited<ReturnType<typeof natsFixture>>;
type Journey = ReturnType<typeof memoryJourney>;
let scopeId: Journey['scopeId'];
let memoryWrittenExample: Journey['memoryWrittenExample'];
let reference: Journey['reference'];
let input: Journey['input'];
let prepared: Journey['prepared'];
let append: Journey['append'];
let load: Journey['load'];
let change: Journey['change'];
let invalidate: Journey['invalidate'];
let checkInvalidation: Journey['exactInvalidation'];
let checkUnrelated: Journey['unrelatedChange'];
async function start() {
  setup = await natsFixture();
  const journey = memoryJourney(setup.store, 'test');
  ({ scopeId, memoryWrittenExample, reference, input, prepared, append, load, change,
    invalidate, exactInvalidation: checkInvalidation, unrelatedChange: checkUnrelated } = journey);
  await journey.start();
}
async function close() {
  vi.restoreAllMocks();
  await setup?.close();
}
function exactInvalidation(kind: 'corrected' | 'forgotten') {
  return checkInvalidation(kind);
}
function unrelatedChange(kind: 'corrected' | 'forgotten') {
  return checkUnrelated(kind);
}
beforeEach(start);
afterEach(close);
it.each(['corrected', 'forgotten'] as const)(
  'records one exact invalidation after a loaded fact is %s', exactInvalidation);

async function loadExpiringFact(transitive = false) {
  const expiresAt = Date.now() + 60_000;
  const data = { ...memoryWrittenExample, scopeId, memoryId: 'expiring', pinned: true,
    expiresAt: new Date(expiresAt).toISOString() };
  await append(`scope-${scopeId}`, 'memory.written', data);
  let expiring = { ...reference, memoryId: 'expiring' };
  if (transitive) {
    for (const memoryId of ['middle', 'leaf']) {
      await append(`scope-${scopeId}`, 'memory.written', { ...memoryWrittenExample,
        scopeId, memoryId, dependsOn: [expiring] });
      expiring = { ...reference, memoryId };
    }
  }
  const recall = { callDigest: 'c'.repeat(64), dispatchDigest: 'd'.repeat(64) };
  await load([expiring], recall);
  return { expiresAt, expiring };
}

async function recoverAfterExpiry(offset: number) {
  const { expiresAt } = await loadExpiringFact();
  await change('forgotten', 'expiring');
  const receipt = await invalidate();
  expect(receipt).toMatchObject({ status: 'invalidated', inputGeneration: 'input' });
  const position = await setup.store.head('conversation-chat');
  const clock = vi.spyOn(Date, 'now').mockReturnValue(expiresAt + offset);
  try {
    expect(await invalidate()).toEqual(receipt);
    expect(await setup.store.head('conversation-chat')).toBe(position);
  } finally {
    clock.mockRestore();
  }
}
it.each([0, 60_000])(
  'recovers the exact receipt %i ms after the old fact expires', recoverAfterExpiry);

async function delayedInvalidation(kind: 'corrected' | 'forgotten', offset: number) {
  const { expiresAt, expiring } = await loadExpiringFact();
  await change(kind, 'expiring');
  const clock = vi.spyOn(Date, 'now').mockReturnValue(expiresAt + offset);
  try {
    const receipt = await invalidate();
    expect(receipt).toMatchObject({ status: 'invalidated', inputGeneration: 'input' });
    const facts = await readChatFacts(setup.store, 'test', 'chat', 'turn');
    expect(facts.memoryContext).toMatchObject({ status: 'invalidated',
      references: [reference, expiring], executionAvailable: false });
    expect(facts.memoryContext?.events.size).toBe(4);
    expect(await invalidate()).toEqual(receipt);
  } finally {
    clock.mockRestore();
  }
}
const delayedChanges = [
  ['corrected', 0], ['corrected', 60_000], ['forgotten', 0], ['forgotten', 60_000],
] as const;
it.each(delayedChanges)(
  'records a saved %s cause first processed %i ms after expiry', delayedInvalidation);

async function lostReplyAfterExpiry() {
  const { expiresAt } = await loadExpiringFact();
  await change('forgotten', 'expiring');
  const appendSaved = setup.store.append.bind(setup.store);
  async function loseReply(command: Parameters<typeof appendSaved>[0]): Promise<never> {
    appendSpy.mockRestore();
    const result = await appendSaved(command);
    expect(result.status).toBe('appended');
    throw new Error('Private error canary');
  }
  const appendSpy = vi.spyOn(setup.store, 'append').mockImplementationOnce(loseReply);
  expect(await invalidate()).toEqual({ status: 'unavailable' });
  const rows = await history(setup.store, 'conversation-chat', 'test');
  const saved = memoryContextRecordedEventSchema.parse(rows.at(-1)!.event);
  expect(saved.data.action).toBe('invalidated');
  const receipt = { status: 'invalidated', eventId: saved.id, inputGeneration: 'input' };
  const clock = vi.spyOn(Date, 'now').mockReturnValue(expiresAt + 60_000);
  const read = setup.store.readStream.bind(setup.store);
  async function* unavailableMemoryHistory(...args: Parameters<typeof read>) {
    if (args[0] === `scope-${scopeId}`) {
      throw new Error('Memory history unavailable');
    }
    yield* read(...args);
  }
  const readSpy = vi.spyOn(setup.store, 'readStream').mockImplementation(unavailableMemoryHistory);
  try {
    expect(await invalidate()).toEqual(receipt);
    expect(await invalidate()).toEqual(receipt);
    expect(await setup.store.head('conversation-chat')).toBe(rows.at(-1)!.sequence);
    const facts = await readChatFacts(setup.store, 'test', 'chat', 'turn');
    expect(facts.memoryContext?.events.size).toBe(4);
  } finally {
    readSpy.mockRestore();
    clock.mockRestore();
  }
}
it('recovers one lost append receipt after expiry without rereading memory', lostReplyAfterExpiry);

async function dependencyInvalidation(kind: 'corrected' | 'forgotten') {
  await append(`scope-${scopeId}`, 'memory.written', { ...memoryWrittenExample,
    scopeId, memoryId: 'derived', dependsOn: [reference] });
  const derived = { ...reference, memoryId: 'derived' };
  await load([derived], { callDigest: 'c'.repeat(64), dispatchDigest: 'd'.repeat(64) });
  await change(kind, 'base');
  expect(await invalidate()).toMatchObject({ status: 'invalidated' });
  const cold = { readStream: setup.store.readStream.bind(setup.store) };
  const facts = await readChatFacts(cold, 'test', 'chat', 'turn');
  expect(facts.memoryContext).toMatchObject({ status: 'invalidated',
    references: [reference, derived], executionAvailable: false });
}
it.each(['corrected', 'forgotten'] as const)(
  'retains every loaded reference when its dependency is %s', dependencyInvalidation);

it.each(['corrected', 'forgotten'] as const)(
  'leaves loaded memory unchanged after an unrelated fact is %s', unrelatedChange);

const wrongBindings = [{ conversationId: 'other' }, { turnId: 'other' },
  { threadId: 'other' }, { inputGeneration: 'replacement' }, { causeId: 'fabricated' }];
async function wrongBinding(patch: object) {
  await change('corrected');
  const position = await setup.store.head('conversation-chat');
  expect(await invalidate(patch)).toEqual({ status: 'refused' });
  expect(await setup.store.head('conversation-chat')).toBe(position);
}
it.each(wrongBindings)('refuses a mismatched binding or fabricated cause: %j', wrongBinding);

async function wrongSilo() {
  await change('forgotten');
  const options = { silo: 'other', store: setup.store };
  expect(await invalidateMemoryContext(options, input)).toEqual({ status: 'refused' });
}
it('refuses another silo without revealing its evidence', wrongSilo);

async function missingEvidence() {
  await change('forgotten');
  await append('conversation-chat', 'agent.memory_context_recorded',
    { ...prepared, turnId: 'empty' });
  expect(await invalidate({ turnId: 'empty' })).toEqual({ status: 'refused' });
}
it('refuses preparation without loaded evidence', missingEvidence);

async function oldReadAccess() {
  await change('forgotten');
  const read = setup.store.readStream.bind(setup.store);
  async function* onlySavedEvidence(...args: Parameters<typeof read>) {
    expect(['conversation-chat', 'participation-chat', `scope-${scopeId}`]).toContain(args[0]);
    yield* read(...args);
  }
  const spy = vi.spyOn(setup.store, 'readStream').mockImplementation(onlySavedEvidence);
  try {
    expect(await invalidate()).toMatchObject({ status: 'invalidated' });
  } finally {
    spy.mockRestore();
  }
}
it('withdraws use without consulting the former reader or any grant', oldReadAccess);

async function anotherSession() {
  await append('conversation-other', 'conversation.created', { conversationId: 'other',
    createdBy: 'alice', assistantId: 'assistant', mode: 'agent_session' });
  await append('conversation-other', 'agent.memory_context_recorded',
    { ...prepared, conversationId: 'other' });
  const position = await setup.store.head(`scope-${scopeId}`);
  await append('conversation-other', 'agent.memory_context_recorded', { ...prepared,
    conversationId: 'other', action: 'loaded', delivery: 'initial', additions: [reference],
    scopePositions: [{ scopeId, position }], byteCount: 100 });
  await change('corrected');
  expect(await invalidate()).toMatchObject({ status: 'invalidated' });
  const other = await readChatFacts(setup.store, 'test', 'other', 'turn');
  expect(other.memoryContext?.status).toBe('loaded');
}
it('records no transition in another session', anotherSession);

async function racingAppend(kind: 'recall' | 'closed' | 'lost') {
  await change('corrected');
  const appendSaved = setup.store.append.bind(setup.store);
  async function race(command: Parameters<typeof appendSaved>[0]) {
    spy.mockRestore();
    if (kind === 'recall') {
      await load([], { callDigest: 'c'.repeat(64), dispatchDigest: 'd'.repeat(64) });
    }
    if (kind === 'closed') {
      await append('conversation-chat', 'agent.turn_completed',
        { conversationId: 'chat', turnId: 'turn' });
    }
    const result = await appendSaved(command);
    if (kind === 'lost') throw new Error('Private error canary');
    return result;
  }
  const spy = vi.spyOn(setup.store, 'append').mockImplementationOnce(race);
  const first = await invalidate();
  expect(first).toEqual({ status: kind === 'lost' ? 'unavailable' : 'reload_required' });
  const second = await invalidate();
  expect(second).toMatchObject({ status: 'invalidated' });
  const position = await setup.store.head('conversation-chat');
  expect(await invalidate()).toEqual(second);
  expect(await setup.store.head('conversation-chat')).toBe(position);
  const facts = await readChatFacts(setup.store, 'test', 'chat', 'turn');
  expect(facts.memoryContext?.recallCalls).toBe(kind === 'recall' ? 2 : 1);
  if (kind === 'closed') {
    expect(facts.memoryContext).toMatchObject({ status: 'ended', executionAvailable: false });
  }
}
it.each(['recall', 'closed', 'lost'] as const)(
  'reloads and reconciles after a %s append race', racingAppend);

async function laterRecallRace(kind: 'corrected' | 'forgotten') {
  await change(kind);
  const later = { ...reference, memoryId: 'later' };
  const appendSaved = setup.store.append.bind(setup.store);
  async function recallDuringAppend(command: Parameters<typeof appendSaved>[0]) {
    spy.mockRestore();
    const data = { ...memoryWrittenExample, scopeId, memoryId: later.memoryId };
    await append(`scope-${scopeId}`, 'memory.written', data);
    const recall = { callDigest: 'c'.repeat(64), dispatchDigest: 'd'.repeat(64) };
    await load([later], recall);
    return appendSaved(command);
  }
  const spy = vi.spyOn(setup.store, 'append').mockImplementationOnce(recallDuringAppend);
  expect(await invalidate()).toEqual({ status: 'reload_required' });
  const receipt = await invalidate();
  expect(receipt).toMatchObject({ status: 'invalidated', inputGeneration: 'input' });
  const position = await setup.store.head('conversation-chat');
  expect(await invalidate()).toEqual(receipt);
  expect(await setup.store.head('conversation-chat')).toBe(position);
  const scopePosition = await setup.store.head(`scope-${scopeId}`);
  const cold = { readStream: setup.store.readStream.bind(setup.store) };
  const facts = await readChatFacts(cold, 'test', 'chat', 'turn');
  expect(facts.memoryContext).toMatchObject({ status: 'invalidated',
    references: [reference, later], executionAvailable: false, recallCalls: 2,
    scopePositions: [{ scopeId, position: scopePosition }] });
  expect(facts.memoryContext?.events.size).toBe(4);
}
it.each(['corrected', 'forgotten'] as const)(
  'reconciles a recall of a fact written after the loaded fact was %s', laterRecallRace);

async function unrelatedActivity() {
  await append('conversation-chat', 'message.posted', { conversationId: 'chat',
    authorKind: 'human', authorId: 'alice', contentType: 'text',
    ciphertext: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', keyId: 'key:fixture' }, 'cause');
  const position = await setup.store.head('conversation-chat');
  expect(await invalidate()).toEqual({ status: 'refused' });
  expect(await setup.store.head('conversation-chat')).toBe(position);
}
it('does not treat an ordinary message as a memory change', unrelatedActivity);

async function simultaneousInvalidation() {
  await change('forgotten');
  await Promise.all([invalidate(), invalidate()]);
  const recovered = await invalidate();
  expect(recovered).toMatchObject({ status: 'invalidated' });
  const facts = await readChatFacts(setup.store, 'test', 'chat', 'turn');
  expect(facts.memoryContext?.events.size).toBe(3);
}
it('recovers one transition after concurrent duplicate requests', simultaneousInvalidation);

async function participationRace() {
  await change('corrected');
  const appendSaved = setup.store.append.bind(setup.store);
  async function closeDuringAppend(command: Parameters<typeof appendSaved>[0]) {
    spy.mockRestore();
    await append('participation-chat', 'conversation.closed',
      { conversationId: 'chat', closedBy: 'alice' });
    return appendSaved(command);
  }
  const spy = vi.spyOn(setup.store, 'append').mockImplementationOnce(closeDuringAppend);
  expect(await invalidate()).toEqual({ status: 'reload_required' });
  expect(await invalidate()).toMatchObject({ status: 'invalidated' });
  const facts = await readChatFacts(setup.store, 'test', 'chat', 'turn');
  expect(facts.memoryContext).toMatchObject({ status: 'ended', references: [reference] });
  expect(facts.memoryContext?.events.size).toBe(3);
}
it('reconciles a participation close that crosses the conditional append', participationRace);

async function missingReference() {
  await load([{ ...reference, memoryId: 'missing' }],
    { callDigest: 'c'.repeat(64), dispatchDigest: 'd'.repeat(64) });
  await change('corrected');
  expect(await invalidate()).toEqual({ status: 'refused' });
}
it('refuses loaded references with missing saved memory evidence', missingReference);

async function harmlessActivity() {
  await append('conversation-chat', 'file.uploaded', { conversationId: 'chat', fileId: 'file',
    uploadedBy: 'alice', name: 'file.txt', size: 5, sha256: 'a'.repeat(64),
    mime: 'text/plain', objectKey: 'test/chat/file' });
  await append('conversation-chat', 'message.posted', { conversationId: 'chat',
    authorKind: 'human', authorId: 'alice', contentType: 'text',
    ciphertext: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', keyId: 'key:fixture' });
  await unrelatedChange('corrected');
}
it('leaves unchanged facts alone after messages and uploads', harmlessActivity);

async function completedWithdrawalRefusesRecall() {
  await append('conversation-chat', 'agent.turn_completed',
    { conversationId: 'chat', turnId: 'turn' });
  await change('forgotten');
  const receipt = await invalidate();
  expect(receipt).toMatchObject({ status: 'invalidated' });
  expect(await invalidate()).toEqual(receipt);
  const before = await setup.store.head('conversation-chat');
  const cold = { readStream: setup.store.readStream.bind(setup.store) };
  expect(await readChatFacts(cold, 'test', 'chat', 'turn')).toMatchObject({
    turnEnded: true, memoryContext: { status: 'ended', executionAvailable: false } });
  expect(await setup.store.head('conversation-chat')).toBe(before);
  await load([], { callDigest: 'c'.repeat(64), dispatchDigest: 'd'.repeat(64) });
  await expect(readChatFacts(cold, 'test', 'chat', 'turn')).rejects.toThrow();
}
it('retains completion and refuses later recall after reply withdrawal',
  completedWithdrawalRefusesRecall);

async function anotherCauseAfterCompletion() {
  await change('forgotten');
  const receipt = await invalidate();
  expect(receipt).toMatchObject({ status: 'invalidated' });
  await append('conversation-chat', 'agent.turn_completed',
    { conversationId: 'chat', turnId: 'turn' });
  const next = await append(`scope-${scopeId}`, 'memory.forgotten', { schemaVersion: 1,
    scopeId, scopeKind: 'person', ownerId: 'alice', memoryId: 'base', revision: 2,
    expectedRevision: 1 });
  const before = await setup.store.head('conversation-chat');
  expect(await invalidate({ causeId: next.id })).toEqual({ status: 'refused' });
  expect(await invalidate()).toEqual(receipt);
  expect(await setup.store.head('conversation-chat')).toBe(before);
}
it('keeps one invalidation when a different cause arrives after completion', anotherCauseAfterCompletion);

async function expiryBoundary(transitive: boolean) {
  const { expiresAt, expiring } = await loadExpiringFact(transitive);
  const clock = vi.spyOn(Date, 'now').mockReturnValue(expiresAt - 1);
  try {
    expect(await invalidate({ causeId: undefined })).toEqual({ status: 'unchanged' });
    clock.mockReturnValue(expiresAt);
    const receipt = await invalidate({ causeId: undefined });
    expect(receipt).toMatchObject({ status: 'invalidated', inputGeneration: 'input' });
    const facts = await readChatFacts(setup.store, 'test', 'chat', 'turn');
    expect(facts.memoryContext).toMatchObject({ status: 'invalidated', reason: 'expired',
      references: [reference, expiring], executionAvailable: false });
    expect(await invalidate({ causeId: undefined })).toEqual(receipt);
    expect(facts.memoryContext?.events.size).toBe(4);
  } finally {
    clock.mockRestore();
  }
}
it.each([false, true])('withdraws loaded memory exactly at expiry, transitive=%s', expiryBoundary);

async function delayedExpiryRecovery(lost: boolean) {
  const { expiresAt, expiring } = await loadExpiringFact(true);
  const clock = vi.spyOn(Date, 'now').mockReturnValue(expiresAt + 60_000);
  const appendSaved = setup.store.append.bind(setup.store);
  async function loseReply(command: Parameters<typeof appendSaved>[0]): Promise<never> {
    const result = await appendSaved(command);
    throw new Error(`Private append canary: ${result.status}`);
  }
  if (lost) vi.spyOn(setup.store, 'append').mockImplementationOnce(loseReply);
  const first = await invalidate({ causeId: undefined });
  expect(first.status).toBe(lost ? 'unavailable' : 'invalidated');
  const cold = await createEventStore(setup.connection);
  const options = { silo: 'test', store: cold };
  const request = { ...input, causeId: undefined };
  const receipt = await invalidateMemoryContext(options, request);
  expect(receipt).toMatchObject({ status: 'invalidated' });
  const read = setup.store.readStream.bind(setup.store);
  async function* refuseHistory(...args: Parameters<typeof read>) {
    if (args[0] === `scope-${scopeId}`) throw new Error('Private history canary');
    yield* read(...args);
  }
  cold.readStream = refuseHistory;
  clock.mockReturnValue(expiresAt - 1000);
  expect(await invalidateMemoryContext(options, request)).toEqual(receipt);
  const facts = await readChatFacts(cold, 'test', 'chat', 'turn');
  expect(facts.memoryContext).toMatchObject({ status: 'invalidated', reason: 'expired',
    references: [reference, expiring], executionAvailable: false });
  expect(facts.memoryContext?.events.size).toBe(4);
}
it.each([false, true])('recovers delayed expiry after restart and clock rollback, lost=%s',
  delayedExpiryRecovery);

async function expiryRecallRace() {
  const { expiresAt, expiring } = await loadExpiringFact(true);
  vi.spyOn(Date, 'now').mockReturnValue(expiresAt);
  const later = { ...reference, memoryId: 'later' };
  const appendSaved = setup.store.append.bind(setup.store);
  async function recall(command: Parameters<typeof appendSaved>[0]) {
    spy.mockRestore();
    await append(`scope-${scopeId}`, 'memory.written', { ...memoryWrittenExample,
      scopeId, memoryId: later.memoryId });
    await load([later], { callDigest: 'e'.repeat(64), dispatchDigest: 'f'.repeat(64) });
    return appendSaved(command);
  }
  const spy = vi.spyOn(setup.store, 'append').mockImplementationOnce(recall);
  expect(await invalidate({ causeId: undefined })).toEqual({ status: 'reload_required' });
  const receipt = await invalidate({ causeId: undefined });
  expect(receipt).toMatchObject({ status: 'invalidated' });
  const facts = await readChatFacts(setup.store, 'test', 'chat', 'turn');
  expect(facts.memoryContext).toMatchObject({ reason: 'expired',
    references: [reference, expiring, later], recallCalls: 3 });
  expect(facts.memoryContext?.events.size).toBe(5);
}
it('a later live recall cannot hide an older expired dependency', expiryRecallRace);

async function correctionRacesExpiry(expiryFirst: boolean) {
  const { expiresAt, expiring } = await loadExpiringFact();
  await change('corrected', 'expiring');
  vi.spyOn(Date, 'now').mockReturnValue(expiresAt);
  const appendSaved = setup.store.append.bind(setup.store);
  let accepted: Awaited<ReturnType<typeof invalidate>> | undefined;
  async function race(command: Parameters<typeof appendSaved>[0]) {
    spy.mockRestore();
    const causeId = expiryFirst ? undefined : 'cause';
    accepted = await invalidate({ causeId });
    return appendSaved(command);
  }
  const spy = vi.spyOn(setup.store, 'append').mockImplementationOnce(race);
  const secondCause = expiryFirst ? 'cause' : undefined;
  expect(await invalidate({ causeId: secondCause })).toEqual({ status: 'reload_required' });
  expect(accepted).toMatchObject({ status: 'invalidated' });
  expect(await invalidate({ causeId: secondCause })).toEqual({ status: 'refused' });
  const facts = await readChatFacts(setup.store, 'test', 'chat', 'turn');
  expect(facts.memoryContext).toMatchObject({ references: [reference, expiring],
    reason: expiryFirst ? 'expired' : 'content_changed' });
  expect(facts.memoryContext?.events.size).toBe(4);
}
it.each([false, true])('keeps the first durable invalidation, expiry first=%s', correctionRacesExpiry);

async function refusesExpiryProof(field: string) {
  const values: Record<string, unknown> = { checkedAt: 9999999999999,
    references: [reference], reason: 'expired' };
  const patch = { [field]: values[field] };
  await loadExpiringFact();
  expect(await invalidate({ causeId: undefined, ...patch })).toEqual({ status: 'refused' });
  const facts = await readChatFacts(setup.store, 'test', 'chat', 'turn');
  expect(facts.memoryContext?.status).toBe('loaded');
}
it.each(['checkedAt', 'references', 'reason'])(
  'refuses caller expiry proof %j', refusesExpiryProof);

async function unavailableExpiryHistory() {
  const { expiresAt } = await loadExpiringFact();
  vi.spyOn(Date, 'now').mockReturnValue(expiresAt);
  const read = setup.store.readStream.bind(setup.store);
  async function* unavailable(...args: Parameters<typeof read>) {
    if (args[0] === `scope-${scopeId}`) throw new Error('Private history canary');
    yield* read(...args);
  }
  vi.spyOn(setup.store, 'readStream').mockImplementation(unavailable);
  expect(await invalidate({ causeId: undefined })).toEqual({ status: 'refused' });
  const facts = await readChatFacts(setup.store, 'test', 'chat', 'turn');
  expect(facts.memoryContext?.events.size).toBe(3);
  expect(facts.memoryContext?.status).toBe('loaded');
}
it('does not claim proven expiry when history is unavailable', unavailableExpiryHistory);

async function expiredAtLoadDoesNotBlockForget(transitive: boolean) {
  const expiresAt = Date.now() + 60_000;
  const expiring = { ...reference, memoryId: 'expiring' };
  await append(`scope-${scopeId}`, 'memory.written', { ...memoryWrittenExample,
    scopeId, memoryId: expiring.memoryId, expiresAt: new Date(expiresAt).toISOString() });
  let addition = expiring;
  if (transitive) {
    addition = { ...reference, memoryId: 'dependent' };
    await append(`scope-${scopeId}`, 'memory.written', { ...memoryWrittenExample,
      scopeId, memoryId: addition.memoryId, dependsOn: [expiring] });
  }
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    vi.setSystemTime(expiresAt);
    await load([addition], { callDigest: 'c'.repeat(64), dispatchDigest: 'd'.repeat(64) });
    expect(await invalidate({ causeId: undefined })).toEqual({ status: 'unchanged' });
    await change('forgotten');
    const receipt = await invalidate();
    expect(receipt).toMatchObject({ status: 'invalidated' });
    expect(await invalidate()).toEqual(receipt);
    const cold = { readStream: setup.store.readStream.bind(setup.store) };
    const facts = await readChatFacts(cold, 'test', 'chat', 'turn');
    expect(facts.memoryContext).toMatchObject({ status: 'invalidated',
      reason: 'content_changed', references: [reference, addition], executionAvailable: false });
    expect(facts.memoryContext?.events.size).toBe(4);
  } finally {
    vi.useRealTimers();
  }
}
it.each([false, true])(
  'an addition expired at load time cannot block a later forget, transitive=%s',
  expiredAtLoadDoesNotBlockForget);
