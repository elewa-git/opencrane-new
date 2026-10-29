import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { AppendCommand } from '@opencrane/event-store';
import { event, lostReplyStore } from '@opencrane/event-store/testing';
import { foldRoutineHistory } from '@opencrane/authz';
import { getEventDefinition, foldRoutine, type EventEnvelope,
  type RoutineState } from '@opencrane/events';
import { BudgetActor, budgets, history, readBudget, rebuildBudgetProjection, totals } from '@opencrane/models';
import { createLogger } from '@opencrane/observability';
import { ProjectionRunner, rebuildRoutineProjection, routines } from '@opencrane/projections';
import { database } from '../../../libs/projections/test/database.ts';
import { shortDuplicateWindowFixture, waitForDuplicateWindow } from './support/duplicate-window.ts';
import * as sender from '../src/routine-sender.ts';
import * as cleanupCommands from '../src/routine-stop-budget.ts';
import { finishRoutine } from '../src/routine-finish.ts';

let nats: Awaited<ReturnType<typeof shortDuplicateWindowFixture>>;
let serial: number;
let input: { routineId: string; occurrenceId: string;
  terminalEvidence: { eventId: string; position: number } };
const objectSchema = z.record(z.string(), z.unknown());
const definition = objectSchema.parse(getEventDefinition('routine.created')!.example);
const created = { ...event('created', 'routine-orders', 'routine.created'),
  commandId: 'created', source: 'opencrane-server',
  principal: { kind: 'human' as const, id: 'alice' }, data: { ...definition, status: 'active' } };
const due = { ...created, id: 'due', commandId: 'due', type: 'routine.due',
  principal: { kind: 'system' as const, id: 'opencrane-server' },
  data: getEventDefinition('routine.due')!.example };
const run = foldRoutine(foldRoutine(undefined, created), due).activeRun!;
const root = { rootId: 'allocated-root', conversationId: run.conversationId,
  turnId: run.turnId, threadId: 'private-thread', requesterId: run.definition.ownerId,
  assistantId: run.definition.assistantId, payingGroupId: run.definition.payingGroupId,
  computerId: 'computer', generation: 1, allowanceCents: 1000 };
const computerSubject = `computer-${root.assistantId}`;
const turn = { ...root, task: 'chat_turn', messageId: run.messageId, executionMode: 'restricted' };
const { generation: _generation, allowanceCents: _allowance, ...started } = turn;
const { executionMode: _mode, ...closedIdentity } = started;
function record(subject: string, type: string, data: unknown): EventEnvelope {
  const id = `fixture-${++serial}`;
  let actor = 'opencrane-server';
  let kind: 'human' | 'system' = 'system';
  if (type === 'routine.created' || type === 'routine.run_stop_requested') {
    actor = 'alice';
    kind = 'human';
  } else if (type === 'computer.turn_started' || type === 'computer.turn_closed') {
    actor = 'turn-lifecycle';
  }
  return { ...event(id, subject, type), commandId: id, source: 'opencrane-server',
    principal: { kind, id: actor }, data };
}
async function save(subject: string, type: string, data: unknown) {
  const saved = record(subject, type, data);
  await nats.seed([saved]);
  return { eventId: saved.id, position: await nats.store.head(subject) };
}
async function setup() {
  serial = 0;
  nats = await shortDuplicateWindowFixture();
  await nats.seed([created]);
  await save('routine-orders', 'routine.due', run);
  input = { routineId: 'orders', occurrenceId: 'occurrence',
    terminalEvidence: { eventId: 'missing', position: 1 } };
}
async function cleanup() {
  vi.restoreAllMocks();
  await nats?.close();
}
beforeEach(setup);
afterEach(cleanup);
async function evidence(changes: Record<string, unknown> = {}, kind = '') {
  if (kind !== 'no allocation') {
    const allocation = kind === 'allocation' ? { ...root, requesterId: 'bob' } : root;
    await save('budget-test', 'budget.root_allowance_set', allocation);
  }
  await save(computerSubject, 'computer.ready', { assistantId: root.assistantId,
    computerId: root.computerId, generation: kind === 'generation' ? 2 : 1 });
  if (kind !== 'no start') {
    const start = kind === 'start binding' ? { ...started, threadId: 'other' } : started;
    await save(computerSubject, 'computer.turn_started', start);
  }
  await save('routine-orders', 'routine.run_stop_requested',
    getEventDefinition('routine.run_stop_requested')!.example);
  if (kind !== 'no budget stop') {
    await save('budget-test', 'budget.root_stopped', { rootId: root.rootId,
      reason: 'allowance_exhausted', attemptedBoundCents: 1001, availableCents: 0 });
  }
  if (kind !== 'no closure') {
    input.terminalEvidence = await save(computerSubject, 'computer.turn_closed',
      { ...closedIdentity, status: 'failed', nativeTermination: 'turn_completed', ...changes });
  }
}
function finish(store = nats.store, request: unknown = input, silo = 'test') {
  return finishRoutine(store, silo, request, { enabled: true });
}
async function folded() {
  let state: RoutineState | undefined;
  const completed = new Map<string, NonNullable<RoutineState['activeRun']>>();
  for (const row of await history(nats.store, 'routine-orders', 'test')) {
    state = foldRoutineHistory(state, row.event, completed);
  }
  return state!;
}
async function refused(request: unknown = input, silo = 'test') {
  const before = await nats.store.head();
  await expect(finish(nats.store, request, silo)).rejects.toThrow(/^Routine finish refused$/u);
  expect(await nats.store.head()).toBe(before);
  expect((await folded()).activeRun).toEqual(run);
}
async function once() {
  await evidence();
  const before = await nats.store.head();
  const [first, second] = await Promise.all([finish(), finish()]);
  expect(second).toEqual(first);
  await waitForDuplicateWindow(nats);
  await nats.stop();
  await nats.restart();
  expect(await finish()).toEqual(first);
  const rows = await history(nats.store, 'routine-orders', 'test');
  expect(rows).toHaveLength(4);
  expect(rows.at(-1)?.sequence).toBe(before + 1);
  expect(rows.at(-1)?.event.data).toMatchObject({ rootId: run.rootId,
    outcome: 'interrupted', terminalEvidence: input.terminalEvidence });
  const state = await folded();
  expect(state.activeRun).toBeNull();
  expect(state.definition?.next).toEqual(run.slot);
  expect(state.status).toBe('active');
  expect(state.executionAvailable).toBe(false);
}
it('finishes once across concurrent calls, deduplication expiry and restart', once, 20_000);
async function lostReply() {
  await evidence();
  const before = await nats.store.head();
  const lost = await lostReplyStore(nats.connection);
  lost.loseNextReply();
  const first = await finish(lost.store);
  expect(await finish()).toEqual(first);
  expect(await nats.store.head()).toBe(before + 1);
}
it('recovers the saved finish after losing the append reply', lostReply);
const wrongFields = [
  ['computerId', 'other'], ['threadId', 'other'], ['turnId', 'other'],
  ['conversationId', 'other'], ['rootId', 'other'], ['requesterId', 'bob'],
  ['payingGroupId', 'other'], ['assistantId', 'other'], ['messageId', 'other'],
  ['status', 'completed'], ['sharingClass', 'shared_only'],
] as const;
async function wrongClosure(field: string, value: string) {
  await evidence({ [field]: value });
  await refused();
}
it.each(wrongFields)('refuses closure with changed %s', wrongClosure);
async function incomplete(kind: string) {
  await evidence({}, kind);
  await refused();
}
it.each(['no allocation', 'allocation', 'generation', 'start binding', 'no start', 'no budget stop',
  'no closure'])('keeps the slot for %s', incomplete);
async function wrongReference(kind: string) {
  await evidence();
  if (kind === 'silo') {
    await refused(input, 'other');
  } else if (kind === 'occurrence') {
    await refused({ ...input, occurrenceId: 'other' });
  } else {
    const terminalEvidence = { ...input.terminalEvidence, [kind]: kind === 'position' ? 1 : 'other' };
    await refused({ ...input, terminalEvidence });
  }
}
it.each(['silo', 'occurrence', 'eventId', 'position'])('refuses wrong %s', wrongReference);
async function descendant(complete = false) {
  const example = objectSchema.parse(getEventDefinition('delegation.started')!.example);
  const { version: _version, computerAdmission: _admission, ...binding } = example;
  const data = { ...binding, ...root, task: 'native_descendant',
    rootTurnId: root.turnId, rootThreadId: root.threadId,
    parentTurnId: root.turnId, parentThreadId: root.threadId,
    turnId: 'child-turn', threadId: 'child-thread' };
  const { allowanceCents: _cents, ...child } = data;
  const saved = record(computerSubject, 'computer.turn_started', child);
  saved.principal = { kind: 'system', id: 'opencrane-server' };
  await nats.seed([saved]);
  if (complete) {
    const closed = { ...saved, id: `child-close-${serial}`, commandId: `child-close-${serial}`,
      type: 'computer.turn_closed', data: { ...child, status: 'failed' } };
    await nats.seed([closed]);
  }
}
async function hasDescendant(complete: boolean) {
  await evidence();
  await descendant(complete);
  await refused();
}
it.each([false, true])('refuses descendant admission, including pending agreement: closed=%s',
  hasDescendant);
async function appendRace(kind: string) {
  await evidence();
  const append = nats.store.append.bind(nats.store);
  async function changed(command: AppendCommand) {
    if (kind === 'descendant') {
      await descendant();
    } else {
      await save(computerSubject, 'computer.ready', { assistantId: root.assistantId,
        computerId: root.computerId, generation: 2 });
    }
    return append(command);
  }
  vi.spyOn(nats.store, 'append').mockImplementationOnce(changed);
  await expect(finish()).rejects.toThrow(/^Routine finish refused$/u);
  expect((await folded()).activeRun).toEqual(run);
}
it.each(['descendant', 'generation'])('rechecks %s changes inside append', appendRace);
async function unavailableHistory(kind: string) {
  await evidence();
  const read = nats.store.readStream.bind(nats.store);
  async function* changed(subject: string, from = 1, deadline = Infinity) {
    if (subject === computerSubject) {
      if (kind === 'failed') {
        throw new Error('private-service-canary');
      }
      vi.spyOn(performance, 'now').mockReturnValue(deadline + 1);
    }
    yield* read(subject, from, deadline);
  }
  vi.spyOn(nats.store, 'readStream').mockImplementation(changed);
  await refused();
}
it.each(['failed', 'slow'])('keeps the slot after %s history', unavailableHistory);
async function defaultReplay() {
  await evidence();
  const before = await nats.store.head();
  expect(await finishRoutine(nats.store, 'test', input)).toEqual({ status: 'disabled' });
  expect(await finishRoutine(nats.store, 'test', input, { enabled: true, replay: true }))
    .toEqual({ status: 'disabled' });
  expect(await nats.store.head()).toBe(before);
}
it('appends nothing by default or during replay', defaultReplay);
async function lateClosure() {
  await evidence();
  const first = await finish();
  const replacement = { ...run, occurrenceId: 'b', conversationId: 'chat-b', turnId: 'turn-b',
    rootId: 'root-b', messageId: 'message-b' };
  await save('routine-orders', 'routine.due', replacement);
  const before = await nats.store.head();
  expect(await finish()).toEqual(first);
  await expect(finish(nats.store, { ...input, occurrenceId: 'b' }))
    .rejects.toThrow(/^Routine finish refused$/u);
  expect(await nats.store.head()).toBe(before);
  expect((await folded()).activeRun).toEqual(replacement);
}
it('keeps B occupied when A closure arrives again', lateClosure);
async function rebuild() {
  await evidence();
  const storage = await database('pg');
  const logger = createLogger('routine-finish-test', { level: 'silent' });
  try {
    const modelCall = { ...root, model: 'gpt-6-luna', priceTableId: 'openai-2026-10-02-all-eur95',
      contextDigest: 'a'.repeat(64) };
    const { allowanceCents: _cents, rootId: _root, ...call } = modelCall;
    await save('budget-test', 'budget.reserved', { reservationId: 'hold', permitId: 'permit',
      amountCents: 210, payingGroupId: root.payingGroupId, assistantId: root.assistantId,
      rootId: root.rootId, modelCall: call });
    await finish();
    const first = (await history(nats.store, 'routine-orders', 'test')).at(-1)!;
    const duplicate = { ...first.event, id: 'duplicate-outcome', commandId: 'duplicate-outcome',
      data: { ...objectSchema.parse(first.event.data), outcome: 'succeeded' } };
    await nats.seed([duplicate]);
    const runner = new ProjectionRunner(storage.db, nats.reader, logger);
    await runner.initialise(routines);
    await runner.initialise(budgets);
    await runner.run(routines);
    await runner.run(budgets);
    const before = await storage.db.query('SELECT * FROM routine_occurrences');
    const money = await readBudget(storage.db, 'test');
    expect(totals(money).reservedCents).toBe(210);
    expect(money.roots[0]?.stop).toBeDefined();
    const append = vi.spyOn(nats.store, 'append');
    const stop = vi.spyOn(cleanupCommands, 'applyRoutineStop');
    const senderPreparation = vi.spyOn(sender, 'createRoutineSender');
    const rootStop = vi.spyOn(BudgetActor.prototype, 'stopRoot');
    for (let index = 0; index < 2; index++) {
      await rebuildRoutineProjection(storage.db, nats.reader, logger, { verify: true });
      await rebuildBudgetProjection(storage.db, nats.reader, logger, { verify: true });
      expect((await storage.db.query('SELECT * FROM routine_occurrences')).rows).toEqual(before.rows);
      expect(await readBudget(storage.db, 'test')).toEqual(money);
    }
    expect(append).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    expect(senderPreparation).not.toHaveBeenCalled();
    expect(rootStop).not.toHaveBeenCalled();
    expect((await folded()).lastRun?.outcome).toBe('interrupted');
    await save('budget-test', 'budget.settled', { reservationId: 'hold', permitId: 'permit', settledCents: 260 });
    await runner.run(budgets);
    await rebuildBudgetProjection(storage.db, nats.reader, logger, { verify: true });
    const settled = await readBudget(storage.db, 'test');
    expect(settled.reservations[0]?.settledCents).toBe(260);
    expect(settled.roots[0]?.stop).toEqual(money.roots[0]?.stop);
  } finally {
    await storage.close();
  }
}
it('rebuilds twice with first outcome, positions, stopped root, 210 held cents and late settlement',
  rebuild, 30_000);

async function nonTerminal(kind: string) {
  await evidence({}, 'no closure');
  if (kind === 'agent completed') {
    input.terminalEvidence = await save(`conversation-${run.conversationId}`,
      'agent.turn_completed', { conversationId: run.conversationId, turnId: run.turnId });
  } else if (kind === 'socket loss') {
    input.terminalEvidence = await save(computerSubject, 'computer.lost',
      { assistantId: root.assistantId, computerId: root.computerId });
  } else if (kind === 'timeout') {
    input.terminalEvidence = await save('budget-test', 'budget.reservation_expired',
      { reservationId: 'uncertain' });
  } else {
    input.terminalEvidence.eventId = 'private_output_cleared';
  }
  await refused();
}
it.each(['agent completed', 'socket loss', 'timeout', 'output clearance'])(
  'does not use %s as termination evidence', nonTerminal);
async function forgedServerRecord(kind: string) {
  await evidence({}, 'no closure');
  const closed = record(computerSubject, 'computer.turn_closed', { ...started, status: 'failed', nativeTermination: 'turn_completed' });
  if (kind === 'source') closed.source = 'computer';
  if (kind === 'principal') closed.principal = { kind: 'system', id: 'computer' };
  await nats.seed([closed]);
  input.terminalEvidence = { eventId: closed.id, position: await nats.store.head() };
  await refused();
}
it.each(['source', 'principal'])('refuses closure from a different %s', forgedServerRecord);
async function reusedAllocation() {
  await evidence();
  await finish();
  await save('routine-orders', 'routine.due', { ...run, occurrenceId: 'reused' });
  await expect(finish(nats.store, { ...input, occurrenceId: 'reused' }))
    .rejects.toThrow(/^Routine finish refused$/u);
  expect((await folded()).activeRun?.occurrenceId).toBe('reused');
}
it('refuses an allocation saved before the occurrence', reusedAllocation);

async function unconfirmedClosure() {
  await evidence({ nativeTermination: undefined });
  await refused();
}
it('keeps the occurrence occupied when failure has no confirmed native termination',
  unconfirmedClosure);

const neighbourRoot = { ...root, rootId: 'neighbour-root', conversationId: 'neighbour-chat',
  turnId: 'neighbour-turn', threadId: 'neighbour-thread' };
type Neighbour = 'allocation' | 'settlement' | 'chat' | 'routine edit';
async function saveNeighbour(kind: Neighbour) {
  if (kind === 'allocation') {
    await save('budget-test', 'budget.root_allowance_set', neighbourRoot);
  } else if (kind === 'settlement') {
    await save('budget-test', 'budget.settled', { reservationId: 'neighbour-hold',
      permitId: 'neighbour-permit', settledCents: 260 });
  } else if (kind === 'routine edit') {
    await save('routine-orders', 'routine.run_stop_requested',
      getEventDefinition('routine.run_stop_requested')!.example);
  } else {
    await save(computerSubject, 'computer.turn_started', { ...started,
      rootId: neighbourRoot.rootId, conversationId: neighbourRoot.conversationId,
      turnId: neighbourRoot.turnId, threadId: neighbourRoot.threadId, messageId: 'neighbour-input' });
  }
}
async function neighbourEvidence(kind: Neighbour) {
  await evidence();
  if (kind === 'settlement') {
    await save('budget-test', 'budget.root_allowance_set', neighbourRoot);
    await save('budget-test', 'budget.reserved', { reservationId: 'neighbour-hold',
      permitId: 'neighbour-permit', amountCents: 210, rootId: neighbourRoot.rootId,
      payingGroupId: root.payingGroupId, assistantId: root.assistantId });
  }
}
const neighbourCases = [
  ['allocation', false], ['settlement', false], ['chat', false],
  ['allocation', true], ['settlement', true], ['chat', true], ['routine edit', true],
] as const;
async function finishesWithNeighbour(kind: Neighbour, duringPublication: boolean) {
  await neighbourEvidence(kind);
  const append = nats.store.append.bind(nats.store);
  const deadlines: number[] = [];
  let injected = false;
  async function appendWithNeighbour(command: AppendCommand) {
    deadlines.push(command.deadline!);
    if (injected) return append(command);
    injected = true;
    if (!duringPublication) {
      await saveNeighbour(kind);
      return append(command);
    }
    async function checkThenChange() {
      await command.checkAccess!();
      await saveNeighbour(kind);
    }
    return append({ ...command, checkAccess: checkThenChange });
  }
  vi.spyOn(nats.store, 'append').mockImplementation(appendWithNeighbour);
  const result = await finish();
  expect(result.status).toBe('confirmed');
  expect((await folded()).activeRun).toBeNull();
  const rows = await history(nats.store, 'routine-orders', 'test');
  function isFinish(row: typeof rows[number]) {
    return row.event.type === 'routine.run_finished';
  }
  expect(rows.filter(isFinish)).toHaveLength(1);
  expect(new Set(deadlines).size).toBe(1);
  if (duringPublication) expect(deadlines).toHaveLength(2);
}
it.each(neighbourCases)('finishes despite neighbouring %s, during publication=%s',
  finishesWithNeighbour);

async function uncertainOrExpiredConflict(kind: 'uncertain' | 'expired') {
  await evidence();
  const append = nats.store.append.bind(nats.store);
  let calls = 0;
  async function changed(command: AppendCommand) {
    calls++;
    async function changeAfterCheck() {
      await command.checkAccess!();
      await saveNeighbour('chat');
    }
    const result = await append({ ...command, checkAccess: changeAfterCheck });
    expect(result.status).toBe('conflict');
    if (kind === 'expired') {
      vi.spyOn(performance, 'now').mockReturnValue(command.deadline! + 1);
      return result;
    }
    return { status: 'conflict' as const, outcome: {
      kind: 'conditional_rejection_unchanged' as const, rows: [], possiblyPublished: true } };
  }
  vi.spyOn(nats.store, 'append').mockImplementation(changed);
  await expect(finish()).rejects.toThrow(/^Routine finish refused$/u);
  expect(calls).toBe(1);
  vi.restoreAllMocks();
  expect((await folded()).activeRun).toEqual(run);
}
it.each(['uncertain', 'expired'] as const)(
  'does not republish after an %s conflict', uncertainOrExpiredConflict);

async function relevantChangeDuringRetry(kind: 'thread reuse' | 'allocation' | 'generation') {
  await evidence();
  const append = nats.store.append.bind(nats.store);
  let calls = 0;
  async function changed(command: AppendCommand) {
    calls++;
    if (calls === 1) {
      async function changeAfterCheck() {
        await command.checkAccess!();
        await saveNeighbour('chat');
      }
      return append({ ...command, checkAccess: changeAfterCheck });
    }
    if (kind === 'thread reuse') {
      await save(computerSubject, 'computer.turn_started', { ...started,
        turnId: 'reused-thread-turn', messageId: 'other-input' });
    } else if (kind === 'allocation') {
      await save('budget-test', 'budget.root_allowance_set', { ...root, allowanceCents: 2000 });
    } else {
      await save(computerSubject, 'computer.ready', { assistantId: root.assistantId,
        computerId: root.computerId, generation: 2 });
    }
    return append(command);
  }
  vi.spyOn(nats.store, 'append').mockImplementation(changed);
  await expect(finish()).rejects.toThrow(/^Routine finish refused$/u);
  expect(calls).toBe(2);
  expect((await folded()).activeRun).toEqual(run);
}
it.each(['thread reuse', 'allocation', 'generation'] as const)(
  'rechecks relevant %s changes on a publication retry', relevantChangeDuringRetry);
