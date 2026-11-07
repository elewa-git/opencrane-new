import { afterEach, beforeEach, expect, it } from 'vitest';
import { event, lostReplyStore } from '@opencrane/event-store/testing';
import { foldRoutineHistory } from '@opencrane/authz';
import { getEventDefinition, foldRoutine, type EventEnvelope,
  type RoutineState } from '@opencrane/events';
import { history } from '@opencrane/models';
import { shortDuplicateWindowFixture, waitForDuplicateWindow } from './support/duplicate-window.ts';
import { finishRoutine } from '../src/routine-finish.ts';

const createdExample = getEventDefinition('routine.created')!.example as Record<string, unknown>;
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
let serial: number;
let terminalEvidence: { eventId: string; position: number };
let resultReference: { eventId: string; position: number };
function record(subject: string, type: string, data: unknown): EventEnvelope {
  const id = `success-${++serial}`;
  const principalId = type.startsWith('computer.') ? 'turn-lifecycle' : 'opencrane-server';
  return { ...event(id, subject, type), commandId: id, source: 'opencrane-server',
    principal: { kind: 'system', id: principalId }, data };
}
async function save(subject: string, type: string, data: unknown) {
  const saved = record(subject, type, data);
  await nats.seed([saved]);
  return { eventId: saved.id, position: await nats.store.head(subject) };
}
async function setup() {
  serial = 0;
  nats = await shortDuplicateWindowFixture();
  await nats.seed([created, due]);
  terminalEvidence = { eventId: 'missing', position: 1 };
  resultReference = { eventId: 'missing', position: 1 };
}
async function cleanup() { await nats?.close(); }
beforeEach(setup);
afterEach(cleanup);
async function evidence(changes: { release?: Record<string, unknown>; outcome?: string;
  settled?: boolean; stop?: boolean; closed?: boolean } = {}) {
  await save('budget-test', 'budget.root_allowance_set', root);
  await save(computerSubject, 'computer.ready', { assistantId: root.assistantId,
    computerId: root.computerId, generation: 1 });
  const started = { ...root, task: 'chat_turn', messageId: run.messageId,
    executionMode: 'restricted' };
  const { allowanceCents: _allowance, generation: _generation, ...start } = started;
  await save(computerSubject, 'computer.turn_started', start);
  const boundRelease = { ...release, ...changes.release };
  await save(`decision-${requestId}`, 'decision.recorded', {
    ...call, requestId, requesterId: root.requesterId, assistantId: root.assistantId,
    permitId: release.permitId, route: 'mcp', outcome: 'allow', reason: 'policy_allow',
    contextDigest: '1'.repeat(64), release: boundRelease });
  await save(`decision-${requestId}`, 'tool.dispatch_recorded', {
    ...call, requestId, logicalRequestId: '2'.repeat(64),
    startedAt: '2026-10-09T00:00:00.000Z', durationMs: 3,
    outcome: changes.outcome ?? 'responded', evidence: 'response_received' });
  resultReference = await save(`conversation-${run.conversationId}`,
    'agent.tool_call_finished', { ...call, status: 'completed' });
  await save('budget-test', 'budget.reserved', {
    reservationId: 'hold-1', permitId: release.permitId, amountCents: 210,
    rootId: root.rootId, payingGroupId: root.payingGroupId, assistantId: root.assistantId });
  if (changes.settled !== false) {
    await save('budget-test', 'budget.settled', {
      reservationId: 'hold-1', permitId: release.permitId, settledCents: 260 });
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
  }
}
function finish(store = nats.store) {
  const input = { routineId: 'orders', occurrenceId: run.occurrenceId, terminalEvidence };
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
  expect(rows.filter(row => row.event.type === 'routine.run_finished')).toHaveLength(1);
  expect((await folded()).lastRun).toMatchObject({ outcome: 'succeeded',
    resultReference, terminalEvidence });
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
  { release: { companyAccountId: 'foreign' } },
  { release: { ownerId: 'foreign' } }, { release: { profileRevision: 2 } }])(
  'keeps the slot when success proof is incomplete: %j', refusesUnproven);
