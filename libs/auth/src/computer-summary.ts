import { z } from 'zod';
import { computerTurnStartedDataSchema as startDetails,
  computerTurnClosedDataSchema as closeDetails } from '@opencrane/events';
import type { StoredEvent, SummaryKind } from '@opencrane/event-store';

type ExecutionMode = 'restricted' | 'memory_free';
export type TurnSummary = {
  hasStart: boolean;
  firstClose: { sequence: number; status: z.infer<typeof closeDetails>['status'] } | undefined;
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
  if (!type.startsWith('computer.turn_')) summary.lifecycle = row;
  if (type === 'computer.claimed') summary.claim = row;
  if (type === 'computer.claimed' || type === 'computer.resumed') summary.grant = row;
}
function addClose(summary: ComputerSummary, row: StoredEvent,
  details: z.infer<typeof closeDetails>) {
  const previous = summary.turns.get(details.turnId);
  if (previous?.firstClose) return;
  summary.startCommandCount -= previous?.startCommandKeys?.size ?? 0;
  const closedTurn: TurnSummary = { hasStart: previous?.hasStart ?? false,
    firstClose: { sequence: row.sequence, status: details.status } };
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
