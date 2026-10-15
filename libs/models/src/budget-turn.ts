import { readStreamSummary, type EventStore, type StoredEvent,
  type SummaryKind } from '@opencrane/event-store';
import { applyBudget, budgetStopId, emptyBudget, matchesScope, type BudgetState } from './state.ts';

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

export function turnBudgetStopDetails(store: EventStore, silo: string,
  work: Parameters<typeof budgetStopId>[1], admittedAt: number, deadline: number,
  recordedStopId?: string) {
  function takeDetails(state: BudgetState, position: number) {
    const stopId = recordedStopId ?? budgetStopId(state, work, new Date(), admittedAt);
    function hasId(stop: BudgetState['stops'][number]) {
      return stop.id === stopId;
    }
    const saved = state.stops.find(hasId);
    if (stopId && !saved) throw new Error('Saved stop unavailable');
    if (!saved) return { position, stop: undefined };
    function applies(reason: BudgetState['stops'][number]['reasons'][number]) {
      return matchesScope(reason, work);
    }
    const reasons = saved.reasons.filter(applies);
    const stop = structuredClone({ ...saved, reasons });
    return { position, stop };
  }
  return readStreamSummary(store, silo, `budget-${silo}`, turnBudget, deadline, takeDetails);
}
