import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { computerSummary, isComputerLifecycle, type ComputerSummary } from '@opencrane/auth';
import { foldRoutineHistory } from '@opencrane/authz';
import type { AppendResult, EventStore, StoredEvent } from '@opencrane/event-store';
import { budgetRootAllowanceSetDataSchema, budgetRootStoppedDataSchema,
  computerTurnStartedDataSchema, computerTurnClosedDataSchema,
  type EventEnvelope, type RoutineState } from '@opencrane/events';
import { history } from '@opencrane/models';
import { proveRoutineSuccess, successEvidenceSchema } from './routine-success.ts';

const id = z.string().regex(/^[\w-]{1,200}$/u);
const inputSchema = z.strictObject({ routineId: id, occurrenceId: id,
  terminalEvidence: z.strictObject({ eventId: z.string().min(1).max(300),
    position: z.int().positive() }), successEvidence: successEvidenceSchema.optional() });
type Input = z.infer<typeof inputSchema>;
type Run = NonNullable<RoutineState['activeRun']>;
type Root = z.infer<typeof budgetRootAllowanceSetDataSchema>;
const turnFields = ['rootId', 'conversationId', 'turnId', 'threadId', 'requesterId',
  'assistantId', 'computerId', 'payingGroupId'] as const;

function receipt(row: StoredEvent) {
  return { status: 'confirmed' as const, eventId: row.event.id, position: row.sequence };
}
function savedRun(rows: StoredEvent[], input: Input) {
  let state: RoutineState | undefined;
  let run: Run | undefined;
  let claimPosition = 0;
  let previous: StoredEvent | undefined;
  const completed = new Map<string, Run>();
  for (const row of rows) {
    state = foldRoutineHistory(state, row.event, completed);
    if (!run && state.activeRun?.occurrenceId === input.occurrenceId) {
      run = state.activeRun;
      claimPosition = row.sequence;
    }
    if (!previous && row.event.type === 'routine.run_finished' &&
        state.lastRun?.occurrenceId === input.occurrenceId) {
      previous = row;
    }
  }
  if (!run || (!previous && state?.activeRun?.occurrenceId !== run.occurrenceId)) {
    throw new Error('Missing occurrence');
  }
  return { run, previous, claimPosition, state };
}
function stoppedAllocation(rows: StoredEvent[], run: Run) {
  let root: Root | undefined;
  let position = 0;
  let stopped = false;
  for (const row of rows) {
    if (row.event.type === 'budget.root_allowance_set') {
      const saved = budgetRootAllowanceSetDataSchema.parse(row.event.data);
      if (saved.conversationId !== run.conversationId || saved.turnId !== run.turnId) {
        continue;
      }
      if (root || saved.requesterId !== run.definition.ownerId ||
          saved.assistantId !== run.definition.assistantId ||
          saved.payingGroupId !== run.definition.payingGroupId) {
        throw new Error('Changed allocation');
      }
      root = saved;
      position = row.sequence;
    } else if (row.event.type === 'budget.root_stopped') {
      const savedStop = budgetRootStoppedDataSchema.parse(row.event.data);
      if (root && savedStop.rootId === root.rootId) {
        stopped = true;
      }
    }
  }
  if (!root || !stopped) {
    throw new Error('Missing stopped allocation');
  }
  return { root, position };
}
function rootStops(rows: StoredEvent[], root: Root) {
  const matching: StoredEvent[] = [];
  for (const row of rows) {
    if (row.event.type !== 'budget.root_stopped') continue;
    const stop = budgetRootStoppedDataSchema.parse(row.event.data);
    if (stop.rootId === root.rootId) matching.push(row);
  }
  return matching;
}
function hasRoutineStop(state: RoutineState | undefined) {
  return state?.stopRequested === true;
}
function requireTurn(row: StoredEvent, root: Root, run: Run) {
  const event = row.event;
  const schema = event.type === 'computer.turn_started'
    ? computerTurnStartedDataSchema : computerTurnClosedDataSchema;
  const turn = schema.parse(event.data);
  if (event.source !== 'opencrane-server' || event.principal?.kind !== 'system' ||
      event.principal.id !== 'turn-lifecycle' || turn.task !== 'chat_turn' ||
      turn.messageId !== run.messageId || turn.executionMode === 'memory_free' ||
      (event.type === 'computer.turn_started' && turn.executionMode !== 'restricted')) {
    throw new Error('Invalid server turn');
  }
  for (const field of turnFields) {
    if (turn[field] !== root[field]) {
      throw new Error('Changed turn');
    }
  }
}
function requireMatchingClosure(start: StoredEvent, row: StoredEvent) {
  const started = computerTurnStartedDataSchema.parse(start.event.data);
  const closed = computerTurnClosedDataSchema.parse(row.event.data);
  if (closed.task !== 'chat_turn') {
    throw new Error('Wrong task');
  }
  const { executionMode: _startMode, ...expected } = started;
  const { executionMode: _closeMode, status: _status, budgetStopId: _stop,
    nativeTermination: _termination, ...actual } = closed;
  if (!isDeepStrictEqual(expected, actual)) {
    throw new Error('Changed closure binding');
  }
}
function requireGeneration(summary: ComputerSummary, row: StoredEvent,
  allocation: ReturnType<typeof stoppedAllocation>) {
  const readySchema = z.object({ computerId: z.string(), generation: z.int().positive() });
  const ready = readySchema.parse(summary.lifecycle?.event.data);
  const root = allocation.root;
  if (summary.lifecycle?.event.type !== 'computer.ready' ||
      ready.computerId !== root.computerId || ready.generation !== root.generation ||
      row.sequence <= allocation.position) {
    throw new Error('Changed generation');
  }
}
function requireNativeClosure(closed: StoredEvent | undefined, input: Input,
  summary: ComputerSummary, root: Root) {
  const thread = summary.threads.get(root.threadId);
  if (!closed || closed.event.id !== input.terminalEvidence.eventId ||
      closed.sequence !== input.terminalEvidence.position || thread?.startedTurnIds.size !== 1) {
    throw new Error('Missing closure');
  }
  const termination = computerTurnClosedDataSchema.parse(closed.event.data);
  if (termination.task !== 'chat_turn' || termination.nativeTermination !== 'turn_completed') {
    throw new Error('Missing native termination');
  }
}
function closure(rows: StoredEvent[], allocation: ReturnType<typeof stoppedAllocation>,
  run: Run, input: Input) {
  const root = allocation.root;
  const summary = computerSummary.empty();
  let start: StoredEvent | undefined;
  let closed: StoredEvent | undefined;
  for (const row of rows) {
    const type = row.event.type;
    if (type !== 'computer.turn_started' && type !== 'computer.turn_closed') {
      computerSummary.add(summary, row);
      continue;
    }
    const fields = z.object({ rootId: z.string().optional(), turnId: z.string(),
      task: z.string() }).parse(row.event.data);
    // Refuse the first admission too: its delegation agreement may still be pending.
    if (fields.task === 'native_descendant' && fields.rootId === root.rootId) {
      throw new Error('Descendants need tree completion');
    }
    if (fields.turnId === root.turnId) {
      requireTurn(row, root, run);
      requireGeneration(summary, row, allocation);
      if (type === 'computer.turn_started') {
        start ??= row;
      } else {
        if (!start) {
          throw new Error('Missing start');
        }
        requireMatchingClosure(start, row);
        closed ??= row;
      }
    }
    computerSummary.add(summary, row);
  }
  // Keep the stopped run interrupted even if its native turn completed before Stop arrived.
  requireNativeClosure(closed, input, summary, root);
}
async function load(store: EventStore, subject: string, silo: string, deadline: number) {
  const rows = await history(store, subject, silo, deadline);
  if (performance.now() >= deadline) {
    throw new Error('History expired');
  }
  return rows;
}

function requireUnchangedAllocation(row: StoredEvent, root: Root,
  successReservationId: string | undefined) {
  if (successReservationId && row.event.type === 'budget.root_stopped') {
    const stop = budgetRootStoppedDataSchema.parse(row.event.data);
    if (stop.rootId === root.rootId) throw new Error('Root stop changed');
  }
  if (successReservationId && row.event.type === 'budget.reserved') {
    const hold = z.object({ rootId: z.string().optional() }).parse(row.event.data);
    if (hold.rootId === root.rootId) throw new Error('Root spending changed');
  }
  if (successReservationId && row.event.type === 'budget.settled') {
    const settlement = z.object({ reservationId: z.string() }).parse(row.event.data);
    if (settlement.reservationId === successReservationId) {
      throw new Error('Root settlement changed');
    }
  }
  if (row.event.type !== 'budget.root_allowance_set') {
    return;
  }
  const allocation = budgetRootAllowanceSetDataSchema.parse(row.event.data);
  if (allocation.rootId === root.rootId ||
      (allocation.conversationId === root.conversationId && allocation.turnId === root.turnId)) {
    throw new Error('Allocation changed');
  }
}
function requireUnchangedTurn(row: StoredEvent, root: Root) {
  if (isComputerLifecycle(row.event.type)) {
    throw new Error('Computer lifecycle changed');
  }
  const type = row.event.type;
  if (type !== 'computer.turn_started' && type !== 'computer.turn_closed') {
    return;
  }
  const schema = type === 'computer.turn_started'
    ? computerTurnStartedDataSchema : computerTurnClosedDataSchema;
  const turn = schema.parse(row.event.data);
  if (turn.rootId === root.rootId || turn.turnId === root.turnId ||
      turn.threadId === root.threadId) {
    throw new Error('Root or private thread changed');
  }
}
async function changesSince(store: EventStore, subject: string, silo: string,
  position: number, deadline: number) {
  const rows: StoredEvent[] = [];
  for await (const row of store.readStream(subject, position + 1, deadline)) {
    if (row.event.silo !== silo || row.event.subject !== subject) {
      throw new Error('Wrong execution history');
    }
    rows.push(row);
  }
  if (performance.now() >= deadline) {
    throw new Error('Execution check expired');
  }
  return rows;
}
function executionCheck(store: EventStore, silo: string, root: Root,
  budgetRows: StoredEvent[], computerRows: StoredEvent[], deadline: number,
  successReservationId: string | undefined) {
  let budgetPosition = budgetRows.at(-1)!.sequence;
  let computerPosition = computerRows.at(-1)!.sequence;
  async function check() {
    // Read only new records. Unrelated spending and chats cannot invalidate this ended turn.
    const budgetChanges = await changesSince(store, `budget-${silo}`, silo,
      budgetPosition, deadline);
    for (const row of budgetChanges) {
      requireUnchangedAllocation(row, root, successReservationId);
      budgetPosition = row.sequence;
    }
    const computerChanges = await changesSince(store, `computer-${root.assistantId}`, silo,
      computerPosition, deadline);
    for (const row of computerChanges) {
      requireUnchangedTurn(row, root);
      computerPosition = row.sequence;
    }
  }
  return check;
}
function provenUnsaved(result: AppendResult) {
  if (result.status !== 'conflict') {
    return false;
  }
  const outcome = result.outcome;
  if (outcome?.kind !== 'conditional_rejection_unchanged' &&
      outcome?.kind !== 'conditional_rejection_changed') {
    return false;
  }
  return !outcome.possiblyPublished;
}
function requireNormalStop(rows: StoredEvent[], root: Root, state: RoutineState | undefined,
  computerSubject: string, input: Input) {
  const stops = rootStops(rows, root);
  if (stops.length !== 1 || hasRoutineStop(state) || state?.status !== 'active') {
    throw new Error('Root did not end normally');
  }
  const saved = stops[0]!.event;
  const stop = budgetRootStoppedDataSchema.parse(saved.data);
  if (saved.source !== 'models' || saved.principal?.kind !== 'system' ||
      saved.principal.id !== 'models' || stop.reason !== 'turn_ended' ||
      stop.sourceSubject !== computerSubject ||
      stop.sourcePosition !== input.terminalEvidence.position ||
      stop.sourceEventId !== input.terminalEvidence.eventId) {
    throw new Error('Root did not end normally');
  }
}
function requireCompletedTurn(rows: StoredEvent[], input: Input) {
  function isTerminal(row: StoredEvent) {
    return row.event.id === input.terminalEvidence.eventId;
  }
  const closed = rows.find(isTerminal);
  const terminal = computerTurnClosedDataSchema.parse(closed?.event.data);
  if (terminal.status !== 'completed') throw new Error('Turn did not complete');
}
async function verifiedOutcome(store: EventStore, silo: string, input: Input, run: Run,
  state: RoutineState | undefined, root: Root, budgetRows: StoredEvent[],
  computerRows: StoredEvent[], deadline: number) {
  const stops = rootStops(budgetRows, root);
  if (!input.successEvidence) {
    const first = budgetRootStoppedDataSchema.parse(stops[0]?.event.data);
    if (first.reason === 'turn_ended' && !hasRoutineStop(state)) {
      throw new Error('Normal finish needs call evidence');
    }
    return undefined;
  }
  const computerSubject = `computer-${root.assistantId}`;
  requireNormalStop(budgetRows, root, state, computerSubject, input);
  requireCompletedTurn(computerRows, input);
  return proveRoutineSuccess(store, silo, input.successEvidence, root, run.definition,
    input.routineId, input.occurrenceId, budgetRows, deadline);
}
function finishEvent(silo: string, subject: string, input: Input, run: Run,
  success: Awaited<ReturnType<typeof proveRoutineSuccess>> | undefined): EventEnvelope {
  const hash = createHash('sha256');
  hash.update(JSON.stringify([silo, input.routineId, input.occurrenceId]));
  const commandId = `routine-finish:${hash.digest('hex')}`;
  const { definition: _definition, slot: _slot, firedAt: _firedAt,
    startBy: _startBy, source: _source, ...identity } = run;
  const data = success
    ? { ...identity, outcome: 'succeeded', reason: 'company_call_confirmed',
      terminalEvidence: input.terminalEvidence, ...success }
    : { ...identity, outcome: 'interrupted', reason: 'root_stopped',
      terminalEvidence: input.terminalEvidence };
  return { id: randomUUID(), commandId, subject, silo,
    type: 'routine.run_finished', source: 'opencrane-server',
    principal: { kind: 'system', id: 'opencrane-server' },
    time: new Date().toISOString(), correlation: {}, data };
}
type FinishContext = {
  store: EventStore; silo: string; subject: string; rows: StoredEvent[];
  run: Run; input: Input; root: Root; budgetRows: StoredEvent[];
  computerRows: StoredEvent[]; historyDeadline: number;
  success: Awaited<ReturnType<typeof proveRoutineSuccess>> | undefined;
  requireCurrent: (() => Promise<void>) | undefined;
};
async function publishFinish(context: FinishContext) {
  const { store, silo, subject, rows, run, input, root, budgetRows,
    computerRows, historyDeadline, success, requireCurrent } = context;
  const event = finishEvent(silo, subject, input, run, success);
  const writeDeadline = performance.now() + 2000;
  const successReservationId = success ? input.successEvidence?.reservationId : undefined;
  const checkExecution = executionCheck(store, silo, root,
    budgetRows, computerRows, writeDeadline, successReservationId);
  async function checkCurrentExecution() {
    await checkExecution();
    await requireCurrent?.();
  }
  const command = { event, expectedSequence: rows.at(-1)!.sequence,
    deadline: writeDeadline, historyChecked: true as const, checkAccess: checkCurrentExecution };
  let result = await store.append(command);
  // Retry only a proven unsaved publication, keeping the original deadline and event identity.
  while (provenUnsaved(result) && performance.now() < writeDeadline) {
    const changed = await changesSince(store, subject, silo,
      command.expectedSequence, writeDeadline);
    rows.push(...changed);
    const current = savedRun(rows, input);
    if (current.previous) return receipt(current.previous);
    if (success && (hasRoutineStop(current.state) || current.state?.status !== 'active')) {
      throw new Error('Run prohibited during finish');
    }
    if (!isDeepStrictEqual(current.run, run)) throw new Error('Occurrence changed');
    command.expectedSequence = rows.at(-1)!.sequence;
    result = await store.append(command);
  }
  if (result.status !== 'appended' && result.status !== 'conflict') {
    throw new Error('Finish not saved');
  }
  const latest = await load(store, subject, silo, historyDeadline);
  const saved = savedRun(latest, input).previous;
  if (!saved) throw new Error('Missing finish receipt');
  return receipt(saved);
}

/** Release only an ended, stopped run. Leave scheduling and money to their own commands. */
export async function finishRoutine(store: EventStore, silo: string, raw: unknown,
  options: { enabled?: boolean; replay?: boolean;
    requireCurrent?: () => Promise<void> } = {}) {
  if (options.enabled !== true || options.replay === true) {
    return { status: 'disabled' as const };
  }
  try {
    const input = inputSchema.parse(raw);
    const subject = `routine-${input.routineId}`;
    const deadline = performance.now() + 10_000;
    const rows = await load(store, subject, silo, deadline);
    const { run, previous, claimPosition, state } = savedRun(rows, input);
    const budgetSubject = `budget-${silo}`;
    const budgetRows = await load(store, budgetSubject, silo, deadline);
    const allocation = stoppedAllocation(budgetRows, run);
    if (allocation.position <= claimPosition) {
      throw new Error('Allocation precedes occurrence');
    }
    const computerSubject = `computer-${allocation.root.assistantId}`;
    const computerRows = await load(store, computerSubject, silo, deadline);
    closure(computerRows, allocation, run, input);
    if (previous) return receipt(previous);
    const success = await verifiedOutcome(store, silo, input, run, state,
      allocation.root, budgetRows, computerRows, deadline);
    const context: FinishContext = { store, silo, subject, rows, run, input,
      root: allocation.root, budgetRows, computerRows, historyDeadline: deadline,
      success, requireCurrent: options.requireCurrent };
    return await publishFinish(context);
  } catch {
    throw new Error('Routine finish refused');
  }
}
