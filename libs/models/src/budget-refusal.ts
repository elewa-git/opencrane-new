import { budgetStopId, budgetStopMessage, type BudgetState, type ModelCall } from './state.ts';
import { checkRootGrant } from './root-budget.ts';

export class BudgetRefused extends Error {}

type Append = (type: string, payload: unknown) => Promise<void>;

export async function recordRefusedWork(state: BudgetState, call: ModelCall, stopId: string,
  fresh: (() => Promise<void>) | undefined, append: Append) {
  function matchesWork(work: BudgetState['stoppedWork'][number]) {
    return work.conversationId === call.conversationId && work.turnId === call.turnId;
  }
  if (state.stoppedWork.some(matchesWork)) {
    return;
  }
  const work = { conversationId: call.conversationId, turnId: call.turnId };
  const refusal = { stopId, work };
  // Save the refused turn before replying so a later limit change cannot reopen it.
  await fresh?.();
  await append('budget.exhausted', refusal);
}

export function requireBudget(state: BudgetState, call: ModelCall, now: Date,
  admittedAt?: number) {
  const stopId = budgetStopId(state, call, now, admittedAt);
  if (stopId !== undefined) {
    const message = budgetStopMessage(state, call, stopId);
    throw new BudgetRefused(message);
  }
}

export async function checkBudget(state: BudgetState, call: ModelCall, fresh: () => Promise<void>,
  admittedAt: number, rootId: string | undefined, now: () => Date, append: Append) {
  const position = await checkRootGrant(state, call, rootId, now(), fresh, append, admittedAt);
  const stopId = budgetStopId(state, call, now(), position);
  if (stopId !== undefined) {
    await recordRefusedWork(state, call, stopId, fresh, append);
    requireBudget(state, call, now(), position);
  }
}
