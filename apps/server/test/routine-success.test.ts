import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { AppendCommand } from '@opencrane/event-store';
import { event, lostReplyStore } from '@opencrane/event-store/testing';
import { foldRoutineHistory } from '@opencrane/authz';
import { getEventDefinition, foldRoutine, type EventEnvelope,
  type RoutineState } from '@opencrane/events';
import { BudgetActor, envelope, history, priceTableId } from '@opencrane/models';
import { shortDuplicateWindowFixture, waitForDuplicateWindow } from './support/duplicate-window.ts';
import { finishRoutine } from '../src/routine-finish.ts';

const objectSchema = z.record(z.string(), z.unknown());
const createdExample = objectSchema.parse(getEventDefinition('routine.created')!.example);
const created = { ...event('created', 'routine-orders', 'routine.created'),
  commandId: 'created', source: 'opencrane-server',
  principal: { kind: 'human' as const, id: 'alice' },
  data: { ...createdExample, status: 'active' } };
const due = { ...created, id: 'due', commandId: 'due', type: 'routine.due',
  principal: { kind: 'system' as const, id: 'opencrane-server' },
  data: getEventDefinition('routine.due')!.example };
const run = foldRoutine(foldRoutine(undefined, created), due).activeRun!;
const root = { rootId: run.rootId, conversationId: run.conversationId, turnId: run.turnId,
  threadId: 'private-thread', requesterId: run.definition.ownerId,
  assistantId: run.definition.assistantId, payingGroupId: run.definition.payingGroupId,
  computerId: 'computer', generation: 1, allowanceCents: 1000 };
const computerSubject = `computer-${root.assistantId}`;
const call = { conversationId: run.conversationId, turnId: run.turnId,
  callId: 'call-1', serverId: 'company-server', toolName: 'read' };
const requestId = '00000000-0000-4000-8000-000000000011';
const release = {
  requestId, permitId: 'permit-1', connectionId: run.definition.connectionId,
  profileId: run.definition.profileId, leaseId: 'lease-1', generation: 1,
  purpose: 'tool_call', userId: run.definition.ownerId, ownerId: run.definition.ownerId,
  ownerKind: 'company', assistantId: root.assistantId, computerId: root.computerId,
  computerGeneration: 1, conversationId: root.conversationId, turnId: root.turnId,
  threadId: root.threadId, serverId: call.serverId, toolName: call.toolName,
  profileRevision: run.definition.profileRevision, selectionRevision: 1, policyRevision: 1,
  argumentsDigest: 'a'.repeat(64), scopeDigest: 'b'.repeat(64), accountDigest: 'c'.repeat(64),
  issuedAt: 1_800_000_000_000, expiresAt: 1_800_000_030_000,
  routineId: run.routineId, occurrenceId: run.occurrenceId,
  companyAccountId: run.definition.companyAccountId,
  payingGroupId: root.payingGroupId, connectionRevision: run.definition.connectionRevision,
  schemaDigest: 'd'.repeat(64), toolRevision: 'e'.repeat(64),
  approvalId: 'f'.repeat(64), rootId: root.rootId, destinationDigest: '0'.repeat(64),
};
let nats: Awaited<ReturnType<typeof shortDuplicateWindowFixture>>;
let actor: BudgetActor;
let reservationId: string;
let serial: number;
let terminalEvidence: { eventId: string; position: number };
let resultReference: { eventId: string; position: number };
function record(subject: string, type: string, data: unknown): EventEnvelope {
  const id = `success-${++serial}`;
  let source = 'opencrane-server';
  let principal: EventEnvelope['principal'] = { kind: 'system', id: 'opencrane-server' };
  if (type.startsWith('computer.')) principal = { kind: 'system', id: 'turn-lifecycle' };
  if (type.startsWith('budget.') || type.startsWith('decision.') ||
      type === 'tool.dispatch_recorded') {
    source = 'models';
    principal = { kind: 'system', id: 'models' };
  }
  if (type === 'agent.tool_call_finished') {
    source = 'computer-bridge';
    principal = { kind: 'agent', id: root.assistantId };
  }
  return { ...event(id, subject, type), commandId: id, source, principal, data };
}
async function save(subject: string, type: string, data: unknown,
  correlation: EventEnvelope['correlation'] = {}) {
  const saved = record(subject, type, data);
  saved.correlation = correlation;
  await nats.seed([saved]);
  return { eventId: saved.id, position: await nats.store.head(subject) };
}
async function setup() {
  serial = 0;
  nats = await shortDuplicateWindowFixture();
  await nats.seed([created, due]);
  actor = new BudgetActor(nats.store, 'test');
  terminalEvidence = { eventId: 'missing', position: 1 };
  resultReference = { eventId: 'missing', position: 1 };
}
async function cleanup() {
  vi.restoreAllMocks();
  await nats?.close();
}
beforeEach(setup);
afterEach(cleanup);
async function evidence(changes: { release?: Record<string, unknown>; outcome?: string;
  settled?: boolean; stop?: boolean; closed?: boolean; reason?: string;
  approvalCorrelation?: string } = {}) {
  await save('budget-test', 'budget.root_allowance_set', root);
  await actor.start(10_000, 10_000);
  await save(computerSubject, 'computer.ready', { assistantId: root.assistantId,
    computerId: root.computerId, generation: 1 });
  const started = { ...root, task: 'chat_turn', messageId: run.messageId,
    executionMode: 'restricted' };
  const { allowanceCents: _allowance, generation: _generation, ...start } = started;
  await save(computerSubject, 'computer.turn_started', start);
  const boundRelease = { ...release, ...changes.release };
  await save(`decision-${requestId}`, 'decision.recorded', {
    ...call, requestId, requesterId: root.requesterId, assistantId: root.assistantId,
    permitId: release.permitId, route: 'mcp', outcome: 'allow',
    reason: changes.reason ?? 'approval_used',
    contextDigest: '1'.repeat(64), release: boundRelease },
  { approval: changes.approvalCorrelation ?? release.approvalId });
  await save(`decision-${requestId}`, 'tool.dispatch_recorded', {
    ...call, requestId, logicalRequestId: '2'.repeat(64),
    startedAt: '2026-10-09T00:00:00.000Z', durationMs: 3,
    outcome: changes.outcome ?? 'responded', evidence: 'response_received' });
  resultReference = await save(`conversation-${run.conversationId}`,
    'agent.tool_call_finished', { ...call, status: 'completed' });
  const modelCall = { model: 'gpt-6-luna', priceTableId, requestId: 'model-request',
    computerId: root.computerId, generation: root.generation,
    requesterId: root.requesterId, assistantId: root.assistantId,
    conversationId: root.conversationId, turnId: root.turnId, threadId: root.threadId,
    payingGroupId: root.payingGroupId, contextDigest: '1'.repeat(64) };
  reservationId = await actor.reserve(modelCall, 500, undefined, undefined, root.rootId);
  if (changes.settled !== false) {
    await settle(260);
  }
  if (changes.stop) {
    await save('budget-test', 'budget.root_stopped', { rootId: root.rootId,
      reason: 'routine_stop', sourceSubject: 'routine-orders', sourcePosition: 3,
      sourceEventId: 'stop' });
  }
  if (changes.closed !== false) {
    const { executionMode: _mode, ...identity } = start;
    terminalEvidence = await save(computerSubject, 'computer.turn_closed', {
      ...identity, status: 'completed', nativeTermination: 'turn_completed' });
    if (!changes.stop) {
      await actor.stopRoot(root.rootId, 'turn_ended', computerSubject,
        terminalEvidence.position);
    }
  }
}
async function settle(settledCents: number) {
  const resolution = envelope('test', `effect-${reservationId}`, 'effect.resolved', {
    reservationId, permitId: reservationId, settledCents, outcome: 'settled',
    resolvedBy: 'owner', evidence: [{ kind: 'provider_receipt', reference: 'receipt',
      digest: '0'.repeat(64), amountCents: settledCents }],
  });
  resolution.principal = { kind: 'human', id: 'owner' };
  await actor.settle(resolution);
}
function finish(store = nats.store) {
  const input = { routineId: 'orders', occurrenceId: run.occurrenceId, terminalEvidence,
    successEvidence: { requestId, resultReference, reservationId } };
  return finishRoutine(store, 'test', input, { enabled: true });
}
async function folded() {
  let state: RoutineState | undefined;
  const completed = new Map<string, NonNullable<RoutineState['activeRun']>>();
  for (const row of await history(nats.store, 'routine-orders', 'test')) {
    state = foldRoutineHistory(state, row.event, completed);
  }
  return state!;
}
async function successfulFinish() {
  await evidence();
  const lost = await lostReplyStore(nats.connection);
  lost.loseNextReply();
  const first = await finish(lost.store);
  expect(await finish()).toEqual(first);
  await waitForDuplicateWindow(nats);
  await nats.stop();
  await nats.restart();
  expect(await finish()).toEqual(first);
  const rows = await history(nats.store, 'routine-orders', 'test');
  function isFinish(row: typeof rows[number]) { return row.event.type === 'routine.run_finished'; }
  expect(rows.filter(isFinish)).toHaveLength(1);
  expect((await folded()).lastRun).toMatchObject({ outcome: 'succeeded',
    resultReference, terminalEvidence, settledCents: 260, heldCents: 0 });
  expect((await folded()).activeRun).toBeNull();
}
it('saves one successful result after confirmed company response and settlement',
  successfulFinish, 20_000);
async function refusesUnproven(changes: Parameters<typeof evidence>[0]) {
  await evidence(changes);
  const before = await nats.store.head();
  await expect(finish()).rejects.toThrow(/^Routine finish refused$/u);
  expect(await nats.store.head()).toBe(before);
  expect((await folded()).activeRun).not.toBeNull();
}
it.each([{ settled: false }, { closed: false }, { outcome: 'outcome_unknown' },
  { stop: true }, { reason: 'policy_allow' }, { approvalCorrelation: 'foreign' },
  { release: { companyAccountId: 'foreign' } },
  { release: { ownerId: 'foreign' } }, { release: { rootId: 'foreign' } },
  { release: { turnId: 'foreign' } }, { release: { profileRevision: 2 } }])(
  'keeps the slot when success proof is incomplete: %j', refusesUnproven);
async function lateSettlement() {
  await evidence({ settled: false });
  await expect(finish()).rejects.toThrow(/^Routine finish refused$/u);
  await settle(900);
  await finish();
  expect((await folded()).lastRun).toMatchObject({ outcome: 'succeeded',
    heldCents: 0, settledCents: 900 });
}
it('waits for late settlement and records the full actual overrun', lateSettlement);

async function correctedSettlementDuringPublication() {
  await evidence();
  const append = nats.store.append.bind(nats.store);
  async function correctAfterCheck(command: AppendCommand) {
    async function checkThenCorrect() {
      await command.checkAccess!();
      await settle(500);
    }
    return append({ ...command, checkAccess: checkThenCorrect });
  }
  vi.spyOn(nats.store, 'append').mockImplementationOnce(correctAfterCheck);
  const before = await nats.store.head('routine-orders');
  await expect(finish()).rejects.toThrow(/^Routine finish refused$/u);
  expect(await nats.store.head('routine-orders')).toBe(before);
  expect((await folded()).activeRun).not.toBeNull();
}
it('refuses a larger settlement saved during the final publication check',
  correctedSettlementDuringPublication);
