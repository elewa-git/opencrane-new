import { setTimeout as delay } from 'node:timers/promises';
import { jetstreamManager } from '@nats-io/jetstream';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { natsFixture } from '@opencrane/event-store/testing';
import { databases } from '@opencrane/authz/testing';
import { pgDb, ProjectionRunner } from '@opencrane/projections';
import { createLogger } from '@opencrane/observability';
import { BudgetActor, budgetSummary, budgets, envelope, history, priceTableId,
  readBudget } from '../src/index.ts';
import { replayBudgets, type BudgetState } from '../src/state.ts';
import { rootTotals } from '../src/root-budget.ts';

type Reason = 'requester_stop' | 'turn_ended' | 'access_revoked';
type Evidence = { reason: Reason; type: string; subject: string; data: Record<string, unknown> };
const binding = { requesterId: 'alice', conversationId: 'conversation', turnId: 'turn',
  threadId: 'thread', assistantId: 'assistant', computerId: 'computer', generation: 1,
  payingGroupId: 'group', allowanceCents: 1000 };
const call = { requesterId: 'alice', conversationId: 'conversation', turnId: 'turn',
  threadId: 'thread', assistantId: 'assistant', computerId: 'computer', generation: 1,
  payingGroupId: 'group', model: 'gpt-6-luna', priceTableId, contextDigest: '0'.repeat(64) };
const turn = { conversationId: 'conversation', turnId: 'turn' };
const evidence: Evidence[] = [
  { reason: 'requester_stop', type: 'agent.turn_stop_requested',
    subject: 'conversation-conversation', data: { ...turn, requestedBy: 'alice' } },
  { reason: 'turn_ended', type: 'computer.turn_closed', subject: 'computer-assistant',
    data: { ...turn, assistantId: 'assistant', computerId: 'computer', requesterId: 'alice',
      task: 'chat_turn', status: 'completed' } },
  { reason: 'turn_ended', type: 'agent.turn_completed',
    subject: 'conversation-conversation', data: turn },
  { reason: 'turn_ended', type: 'agent.turn_failed',
    subject: 'conversation-conversation', data: { ...turn, reason: 'model_error' } },
  { reason: 'access_revoked', type: 'participant.removed', subject: 'participation-conversation',
    data: { conversationId: 'conversation', participantId: 'alice', removedBy: 'owner' } },
  { reason: 'access_revoked', type: 'conversation.closed', subject: 'participation-conversation',
    data: { conversationId: 'conversation', closedBy: 'owner' } },
  { reason: 'access_revoked', type: 'member.removed', subject: 'member-alice',
    data: { memberId: 'alice', removedBy: 'owner' } },
];
let nats: Awaited<ReturnType<typeof natsFixture>>;
let actor: BudgetActor;
let clock: Date;
let rootId: string;
function now() { return clock; }
async function setup() {
  nats = await natsFixture();
  clock = new Date('2026-10-10T12:00:00Z');
  actor = new BudgetActor(nats.store, 'test', now);
  await actor.start(10_000, 10_000, 'group');
  rootId = (await actor.setRootAllowance(binding, 1)).rootId;
}
async function close() { await nats.close(); }
beforeEach(setup);
afterEach(close);
async function save(source: Evidence, silo = 'test') {
  const event = envelope(silo, source.subject, source.type, source.data);
  const expectedSequence = await nats.store.head(source.subject);
  const result = await nats.store.append({ event, expectedSequence });
  if (result.status !== 'appended') throw new Error('Evidence fixture append failed');
  return { event, position: result.sequence };
}
async function stop(source: Evidence, position: number, id = rootId) {
  return actor.stopRoot(id, source.reason, source.subject, position);
}
async function reserve() {
  return actor.reserve(call, 1, undefined, undefined, rootId);
}
async function acceptsEvidence(source: Evidence) {
  const saved = await save(source);
  const before = await nats.store.head();
  const expected = { rootId, reason: source.reason, sourceSubject: source.subject,
    sourcePosition: saved.position, sourceEventId: saved.event.id };
  expect(await stop(source, saved.position)).toEqual(expected);
  expect(await stop(source, saved.position)).toEqual(expected);
  await expect(reserve()).rejects.toMatchObject({ reason: source.reason });
  expect(await nats.store.head()).toBe(before + 1);
  const rows = await history(nats.store, 'budget-test', 'test');
  expect(rows.at(-1)?.event).toMatchObject({ type: 'budget.root_stopped', data: expected });
  const otherBinding = { ...binding, turnId: 'other', threadId: 'other' };
  const otherCall = { ...call, turnId: 'other', threadId: 'other' };
  const otherRoot = await actor.setRootAllowance(otherBinding, 1);
  await actor.reserve(otherCall, 1, undefined, undefined, otherRoot.rootId);
  expect(budgetSummary(actor.state, clock)).not.toHaveProperty('roots');
}
it.each(evidence)('saves a permanent $reason from $type and keeps another root usable', acceptsEvidence);

async function refuses(source: Evidence, position: number, id = rootId) {
  const before = await nats.store.head();
  await expect(stop(source, position, id)).rejects.toThrow(/^Root stop evidence refused$/u);
  expect(await nats.store.head()).toBe(before);
}
async function rejectsChangedEvidence(source: Evidence) {
  for (const field of ['conversationId', 'turnId', 'requesterId', 'requestedBy',
    'participantId', 'memberId', 'computerId', 'assistantId']) {
    if (!(field in source.data)) continue;
    const changed = { ...source, data: { ...source.data, [field]: 'someone-else' } };
    if (field === 'conversationId' && source.subject !== 'computer-assistant') {
      changed.subject = source.subject.replace('-conversation', '-someone-else');
    }
    const saved = await save(changed);
    await refuses(changed, saved.position);
  }
  const otherStream = { ...source, subject: source.subject.replace(/-[^-]+$/u, '-other') };
  if (source.subject.startsWith('conversation-') || source.subject.startsWith('participation-')) {
    otherStream.data = { ...source.data, conversationId: 'other' };
  }
  const wrongStream = await save(otherStream);
  await refuses(otherStream, wrongStream.position);
  const wrongSilo = await save(source, 'another-silo');
  await refuses(source, wrongSilo.position);
  const saved = await save(source);
  const wrongReason: Evidence = { ...source, reason: 'requester_stop' };
  if (source.reason === 'requester_stop') wrongReason.reason = 'access_revoked';
  await refuses(wrongReason, saved.position);
  await refuses(source, saved.position, 'unknown-root');
  await refuses(source, saved.position + 1000);
  await refuses(source, 0);
  await refuses(source, 1.5);
}
it.each(evidence)('refuses mismatched $type evidence without exposing ids or writing',
  rejectsChangedEvidence);
async function rejectsBudgetStop() {
  const source: Evidence = { ...evidence[0]!, data: { ...turn, reason: 'budget', stopId: 'stop' } };
  const saved = await save(source);
  await refuses(source, saved.position);
  const legacyClose = { ...evidence[5]!, subject: 'conversation-conversation' };
  const closed = await save(legacyClose);
  await refuses(legacyClose, closed.position);
}
it('refuses budget Stop and closure outside the participation stream', rejectsBudgetStop);

async function retriesFailedRead() {
  const source = evidence[0]!;
  const saved = await save(source);
  const readStream = nats.store.readStream.bind(nats.store);
  // Fail at the store boundary without revealing its error to the caller.
  async function* unavailable(subject: string, position = 1, deadline = Infinity) {
    expect(subject).toBe(source.subject);
    expect(position).toBe(saved.position);
    expect(deadline - performance.now()).toBeGreaterThan(0);
    expect(deadline - performance.now()).toBeLessThanOrEqual(10_000);
    yield* [];
    throw new Error(`Unavailable ${saved.event.id}`);
  }
  nats.store.readStream = unavailable;
  await refuses(source, saved.position);
  nats.store.readStream = readStream;
  await stop(source, saved.position);
}
it('sanitises a failed bounded read and allows retry', retriesFailedRead);
async function readsBeforeQueueing() {
  const source = evidence[0]!;
  const saved = await save(source);
  const readStream = nats.store.readStream.bind(nats.store);
  const gate = Promise.withResolvers<void>();
  async function* slowRead(subject: string, position = 1, deadline = Infinity) {
    if (subject === source.subject) await gate.promise;
    yield* readStream(subject, position, deadline);
  }
  nats.store.readStream = slowRead;
  const pending = stop(source, saved.position);
  try {
    await reserve();
  } finally {
    gate.resolve();
  }
  await pending;
}
it('reads source evidence before entering the serial queue', readsBeforeQueueing);
async function keepsFirstStop() {
  const source = evidence[0]!;
  const saved = await save(source);
  const closed = await save(evidence[5]!);
  const before = await nats.store.head();
  const results = await Promise.all([stop(source, saved.position), stop(source, saved.position)]);
  expect(results[0]).toEqual(results[1]);
  expect(await stop(evidence[5]!, closed.position)).toEqual(results[0]);
  expect(await nats.store.head()).toBe(before + 1);
}
it('serialises repeats and returns the first reason when Stop is followed by close', keepsFirstStop);
async function recoversLostReply() {
  const manager = await jetstreamManager(nats.connection);
  await manager.streams.update('EVENTS', { duplicate_window: 1_000_000_000 });
  const source = evidence[0]!;
  const saved = await save(source);
  const before = await nats.store.head();
  const append = nats.store.append.bind(nats.store);
  async function loseReply(input: Parameters<typeof append>[0]) {
    await append(input);
    nats.store.append = append;
    return { status: 'unavailable' as const, cause: new Error('Reply lost') };
  }
  nats.store.append = loseReply;
  await expect(stop(source, saved.position)).rejects.toThrow('Budget writer lost its fence');
  expect(await nats.store.head()).toBe(before + 1);
  await delay(1100);
  actor = new BudgetActor(nats.store, 'test', now);
  await actor.start();
  const recovered = await nats.store.head();
  expect(await stop(source, saved.position)).toMatchObject({ sourceEventId: saved.event.id });
  expect(await nats.store.head()).toBe(recovered);
}
it('recovers a lost reply and redelivery beyond the NATS duplicate window', recoversLostReply);
async function refusesOldLeader() {
  const source = evidence[0]!;
  const saved = await save(source);
  const replacement = new BudgetActor(nats.store, 'test', now);
  await replacement.start();
  const before = await nats.store.head();
  await expect(stop(source, saved.position)).rejects.toThrow('Budget writer lost its fence');
  expect(await nats.store.head()).toBe(before);
}
it('prevents a replaced leader from saving a stop', refusesOldLeader);
async function settle(reservationId: string, settledCents: number) {
  const data = { reservationId, permitId: reservationId, settledCents, outcome: 'settled',
    resolvedBy: 'owner', evidence: [{ kind: 'provider_receipt', reference: 'receipt',
      digest: '0'.repeat(64), amountCents: settledCents }] };
  const event = { ...envelope('test', `effect-${reservationId}`, 'effect.resolved', data),
    principal: { kind: 'human' as const, id: 'owner' } };
  await actor.settle(event);
}
async function replaysStop(source: Evidence) {
  const first = await actor.reserve(call, 240, undefined, undefined, rootId);
  await settle(first, 240);
  const late = await actor.reserve(call, 110, undefined, undefined, rootId);
  const saved = await save(source);
  const stopped = await stop(source, saved.position);
  expect(rootTotals(actor.state, rootId)).toEqual({
    settledCents: 240, heldCents: 110, availableCents: 650 });
  await settle(late, 70);
  const settledAt = await nats.store.head();
  await settle(late, 70);
  expect(await nats.store.head()).toBe(settledAt);
  expect(rootTotals(actor.state, rootId)).toEqual({
    settledCents: 310, heldCents: 0, availableCents: 690 });
  await actor.configure({ scope: 'global', ceilingCents: 30_000, dailyCeilingCents: 30_000,
    setBy: 'owner' });
  clock = new Date('2026-11-01T12:00:00Z');
  await actor.period();
  actor = new BudgetActor(nats.store, 'test', now);
  await actor.start();
  const before = await nats.store.head();
  await expect(reserve()).rejects.toMatchObject({ reason: source.reason });
  expect(await stop(source, saved.position)).toEqual(stopped);
  const storage = await databases();
  try {
    const db = pgDb(storage.queue);
    const logger = createLogger('test', { level: 'silent' });
    const runner = new ProjectionRunner(db, nats.store, logger);
    await runner.initialise(budgets);
    await runner.run(budgets);
    await runner.initialise(replayBudgets);
    await runner.run(replayBudgets);
    expect(await readBudget(db, 'test')).toEqual(actor.state);
    const rows = await db.query<{ state: BudgetState }>('SELECT state FROM model_budgets_replay');
    expect(rows.rows[0]?.state).toEqual(actor.state);
    expect(actor.state.roots[0]?.stop).toEqual(stopped);
    expect(await nats.store.head()).toBe(before);
  } finally {
    await storage.close();
  }
}
it.each([evidence[0]!, evidence[1]!, evidence[4]!])(
  'keeps $reason and late cost through raised caps, rollover, restart and PostgreSQL replay',
  replaysStop);
