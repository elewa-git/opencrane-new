import { readStreamSummary, type EventStore, type StoredEvent,
  type SummaryKind } from '@opencrane/event-store';
import { applyBudget, budgetStopId, emptyBudget, type BudgetState } from './state.ts';

function addBudget(state: BudgetState, row: StoredEvent) {
  applyBudget(state, row.event, row.sequence);
}
const turnBudget: SummaryKind<BudgetState> = {
  name: 'turn-budget-stops', keep: 4, empty: emptyBudget, add: addBudget,
};

export function turnBudgetStop(store: EventStore, silo: string,
  work: Parameters<typeof budgetStopId>[1], admittedAt: number, deadline: number) {
  function takeStop(state: BudgetState) {
    return budgetStopId(state, work, new Date(), admittedAt);
  }
  // Read history before checking access, then read only new events during renewal.
  return readStreamSummary(store, silo, `budget-${silo}`, turnBudget, deadline, takeStop);
}
