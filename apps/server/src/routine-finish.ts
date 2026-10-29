import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { computerSummary, type ComputerSummary } from '@opencrane/auth';
import { foldRoutineHistory } from '@opencrane/authz';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
import { budgetRootAllowanceSetDataSchema, budgetRootStoppedDataSchema,
  computerTurnStartedDataSchema, computerTurnClosedDataSchema,
  type EventEnvelope, type RoutineState } from '@opencrane/events';
import { history } from '@opencrane/models';

const id = z.string().regex(/^[\w-]{1,200}$/u);
const inputSchema = z.strictObject({ routineId: id, occurrenceId: id,
  terminalEvidence: z.strictObject({ eventId: z.string().min(1).max(300),
    position: z.int().positive() }) });
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
  return { run, previous, claimPosition };
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
      const stop = budgetRootStoppedDataSchema.parse(row.event.data);
      if (root && stop.rootId === root.rootId) {
        stopped = true;
      }
    }
  }
  if (!root || !stopped) {
    throw new Error('Missing stopped allocation');
  }
  return { root, position };
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
function requireFailedClosure(closed: StoredEvent | undefined, input: Input,
  summary: ComputerSummary, root: Root) {
  const thread = summary.threads.get(root.threadId);
  if (!closed || closed.event.id !== input.terminalEvidence.eventId ||
      closed.sequence !== input.terminalEvidence.position || thread?.startedTurnIds.size !== 1 ||
      computerTurnClosedDataSchema.parse(closed.event.data).status !== 'failed') {
    throw new Error('Missing failed closure');
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
  requireFailedClosure(closed, input, summary, root);
}
async function load(store: EventStore, subject: string, silo: string, deadline: number) {
  const rows = await history(store, subject, silo, deadline);
  if (performance.now() >= deadline) {
    throw new Error('History expired');
  }
  return rows;
}

/** Release only an ended, stopped run. Leave scheduling and money to their own commands. */
export async function finishRoutine(store: EventStore, silo: string, raw: unknown,
  options: { enabled?: boolean; replay?: boolean } = {}) {
  if (options.enabled !== true || options.replay === true) {
    return { status: 'disabled' as const };
  }
  try {
    const input = inputSchema.parse(raw);
    const subject = `routine-${input.routineId}`;
    const deadline = performance.now() + 10_000;
    const rows = await load(store, subject, silo, deadline);
    const { run, previous, claimPosition } = savedRun(rows, input);
    const budgetSubject = `budget-${silo}`;
    const budgetRows = await load(store, budgetSubject, silo, deadline);
    const allocation = stoppedAllocation(budgetRows, run);
    if (allocation.position <= claimPosition) {
      throw new Error('Allocation precedes occurrence');
    }
    const computerSubject = `computer-${allocation.root.assistantId}`;
    const computerRows = await load(store, computerSubject, silo, deadline);
    closure(computerRows, allocation, run, input);
    if (previous) {
      return receipt(previous);
    }
    const hash = createHash('sha256');
    hash.update(JSON.stringify([silo, input.routineId, input.occurrenceId]));
    const commandId = `routine-finish:${hash.digest('hex')}`;
    const { definition: _definition, slot: _slot, firedAt: _firedAt,
      startBy: _startBy, source: _source, ...identity } = run;
    const data = { ...identity, outcome: 'interrupted', reason: 'root_stopped',
      terminalEvidence: input.terminalEvidence };
    const event: EventEnvelope = { id: randomUUID(), commandId, subject, silo,
      type: 'routine.run_finished', source: 'opencrane-server',
      principal: { kind: 'system', id: 'opencrane-server' },
      time: new Date().toISOString(), correlation: {}, data };
    const writeDeadline = performance.now() + 2000;
    async function checkExecution() {
      // Keep execution histories outside access streams. The store binds this check to publication.
      const budgetPosition = await store.head(budgetSubject, writeDeadline);
      const computerPosition = await store.head(computerSubject, writeDeadline);
      if (budgetPosition !== budgetRows.at(-1)?.sequence ||
          computerPosition !== computerRows.at(-1)?.sequence) {
        throw new Error('Execution changed');
      }
    }
    const command = { event, expectedSequence: rows.at(-1)!.sequence,
      deadline: writeDeadline, historyChecked: true as const, checkAccess: checkExecution };
    const result = await store.append(command);
    if (result.status !== 'appended' && result.status !== 'conflict') {
      throw new Error('Finish not saved');
    }
    const latest = await load(store, subject, silo, deadline);
    const saved = savedRun(latest, input).previous;
    if (!saved) {
      throw new Error('Missing finish receipt');
    }
    return receipt(saved);
  } catch {
    throw new Error('Routine finish refused');
  }
}
