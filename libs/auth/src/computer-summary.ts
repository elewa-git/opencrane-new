import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { takeoverRequestedDataSchema, takeoverPausingDataSchema,
  takeoverPausedDataSchema, takeoverFailedDataSchema,
  computerTurnStartedDataSchema as startDetails,
  computerTurnClosedDataSchema as closeDetails } from '@opencrane/events';
import { readStreamSummary, type EventStore, type StoredEvent, type SummaryKind }
  from '@opencrane/event-store';

const lifecycleTypes = new Set([
  'computer.claimed', 'computer.ready', 'computer.suspended', 'computer.resumed',
  'computer.lost', 'computer.retired',
]);
export function isComputerLifecycle(type: string) {
  return lifecycleTypes.has(type);
}
export type ComputerControl = (Omit<z.infer<typeof takeoverRequestedDataSchema>, 'reason'> & {
  phase: 'requested' | 'pausing' | 'paused' | 'failed';
  reason: 'requester_requested' | 'pause_timeout';
  supervisorEpoch?: string; bridgeEpoch?: string;
  position: number; commandId: string; requestedAt: string;
}) | { phase: 'unverified'; position: number };
export async function readComputerControl(store: Pick<EventStore, 'readStream'>,
  silo: string, assistantId: string, deadline = performance.now() + 10_000) {
  function take(summary: ComputerSummary) {
    return structuredClone(summary.control);
  }
  return readStreamSummary(store, silo, `computer-${assistantId}`,
    computerSummary, deadline, take);
}
type ExecutionMode = 'restricted' | 'memory_free';
export type TurnSummary = {
  hasStart: boolean;
  firstClose: { sequence: number; status: z.infer<typeof closeDetails>['status'];
    budgetStopId?: string | undefined } | undefined;
  firstStart?: StoredEvent;
  lastStartExecutionMode?: ExecutionMode | undefined;
  startCommandKeys?: Set<string>;
};
export type ThreadSummary = {
  owners: Set<string>;
  startedTurnIds: Set<string>;
  restrictedTurnIds: Set<string>;
};
export type ComputerSummary = {
  control?: ComputerControl;
  lifecycle: StoredEvent | undefined;
  claim: StoredEvent | undefined;
  grant: StoredEvent | undefined;
  turns: Map<string, TurnSummary>;
  threads: Map<string, ThreadSummary>;
  startCommandCount: number;
};
function emptyComputer(): ComputerSummary {
  return { lifecycle: undefined, claim: undefined, grant: undefined,
    turns: new Map(), threads: new Map(), startCommandCount: 0 };
}
function addComputer(summary: ComputerSummary, row: StoredEvent) {
  const type = row.event.type;
  if (type === 'computer.turn_started') {
    const details = startDetails.parse(row.event.data);
    // Keep native task records from granting permission to make calls.
    if (details.task === 'native_descendant') return;
    addStart(summary, row, details);
    return;
  }
  if (type === 'computer.turn_closed') {
    const details = closeDetails.parse(row.event.data);
    if (details.task === 'native_descendant') return;
    addClose(summary, row, details);
    return;
  }
  if (type === 'takeover.requested') {
    const details = takeoverRequestedDataSchema.parse(row.event.data);
    summary.control = { ...details, phase: 'requested', position: row.sequence,
      commandId: z.string().parse(row.event.commandId), requestedAt: row.event.time };
  }
  if (type === 'takeover.pausing' || type === 'takeover.paused' || type === 'takeover.failed') {
    addControl(summary, row);
  }
  // Keep old records paused. They contain no checked proof of writer closure.
  if (type === 'takeover.started' || type === 'takeover.ended') {
    summary.control = { phase: 'unverified', position: row.sequence };
  }
  if (isComputerLifecycle(type)) summary.lifecycle = row;
  if (type === 'computer.claimed') summary.claim = row;
  if (type === 'computer.claimed' || type === 'computer.resumed') summary.grant = row;
}
const controlSchemas = { pausing: takeoverPausingDataSchema, paused: takeoverPausedDataSchema,
  failed: takeoverFailedDataSchema };
function addControl(summary: ComputerSummary, row: StoredEvent) {
  let phase: 'pausing' | 'paused' | 'failed' = 'pausing';
  if (row.event.type === 'takeover.paused') phase = 'paused';
  if (row.event.type === 'takeover.failed') phase = 'failed';
  const parsed = controlSchemas[phase].safeParse(row.event.data);
  const details = parsed.data;
  const control = summary.control;
  if (!details || !control || control.phase === 'unverified'
    || !validControlPhase(control, phase, details)
    || details.takeoverId !== control.takeoverId
    || details.computerId !== control.computerId || details.assistantId !== control.assistantId
    || details.generation !== control.generation || details.podUid !== control.podUid
    || !sameAffectedTurns(details.affectedTurnIds, control.affectedTurnIds)) {
    summary.control = { phase: 'unverified', position: row.sequence };
  } else {
    summary.control = { ...control, phase, position: row.sequence };
    if ('reason' in details) {
      summary.control.reason = details.reason;
    }
    if ('supervisorEpoch' in details) {
      summary.control.supervisorEpoch = details.supervisorEpoch;
      summary.control.bridgeEpoch = details.bridgeEpoch;
    }
  }
}
function validControlPhase(control: Exclude<ComputerControl, { phase: 'unverified' }>,
  phase: 'pausing' | 'paused' | 'failed', details: { generation: number; supervisorEpoch?: string }) {
  if (phase === 'paused') {
    return control.phase === 'pausing' && details.supervisorEpoch === control.supervisorEpoch;
  }
  if (phase === 'pausing') return control.phase === 'requested';
  return control.phase === 'requested' || control.phase === 'pausing';
}
function sameAffectedTurns(first: string[], second: string[]) {
  const sortedFirst = [...first];
  const sortedSecond = [...second];
  sortedFirst.sort();
  sortedSecond.sort();
  return isDeepStrictEqual(sortedFirst, sortedSecond);
}
function addClose(summary: ComputerSummary, row: StoredEvent,
  details: z.infer<typeof closeDetails>) {
  const previous = summary.turns.get(details.turnId);
  if (previous?.firstClose) return;
  summary.startCommandCount -= previous?.startCommandKeys?.size ?? 0;
  const closedTurn: TurnSummary = { hasStart: previous?.hasStart ?? false,
    firstClose: { sequence: row.sequence, status: details.status } };
  if ('budgetStopId' in details && details.budgetStopId) {
    closedTurn.firstClose!.budgetStopId = details.budgetStopId;
  }
  summary.turns.set(details.turnId, closedTurn);
}
function addStart(summary: ComputerSummary, row: StoredEvent,
  details: z.infer<typeof startDetails>) {
  let turn = summary.turns.get(details.turnId);
  if (!turn) {
    turn = { hasStart: true, firstClose: undefined, firstStart: row,
      startCommandKeys: new Set() };
    summary.turns.set(details.turnId, turn);
  }
  turn.hasStart = true;
  if (!turn.firstClose) {
    turn.lastStartExecutionMode = details.executionMode;
    const principal = row.event.principal;
    const commandKey = JSON.stringify([
      principal?.kind, principal?.id, row.event.commandId,
    ]);
    if (turn.startCommandKeys && !turn.startCommandKeys.has(commandKey)) {
      turn.startCommandKeys.add(commandKey);
      summary.startCommandCount++;
    }
  }
  let thread = summary.threads.get(details.threadId);
  if (!thread) {
    thread = { owners: new Set(), startedTurnIds: new Set(), restrictedTurnIds: new Set() };
    summary.threads.set(details.threadId, thread);
  }
  addDistinct(thread.owners, JSON.stringify([details.requesterId, details.conversationId]));
  addDistinct(thread.startedTurnIds, details.turnId);
  if (details.executionMode === 'restricted') addDistinct(thread.restrictedTurnIds, details.turnId);
}
function addDistinct(values: Set<string>, value: string) {
  // Keep two values: they answer whether any value differs from the one being checked.
  if (values.size < 2) values.add(value);
}
export const computerSummary: SummaryKind<ComputerSummary> = {
  name: 'computer', keep: 64, empty: emptyComputer, add: addComputer,
  budget: { limit: 48 * 1024 * 1024, size: computerSize },
};
function computerSize(summary: ComputerSummary) {
  // Allow room above measured UUID costs without scanning old turns on every use.
  return summary.turns.size * 256 + summary.threads.size * 768 +
    summary.startCommandCount * 2048;
}
