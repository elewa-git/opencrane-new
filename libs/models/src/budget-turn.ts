import { readStreamSummary, type EventStore, type StoredEvent,
  type SummaryKind } from '@opencrane/event-store';
import { applyBudget, budgetStopId, emptyBudget, matchesScope, type BudgetState } from './state.ts';
import type { BudgetStopStatus } from '@opencrane/protocol';
import type { computerTurnStartedDataSchema } from '@opencrane/events';

type Descendant = Extract<ReturnType<typeof computerTurnStartedDataSchema.parse>,
  { task: 'native_descendant' }>;

type TurnBudget = BudgetState & { callPositions: Map<string, number> };
type Reservation = BudgetState['reservations'][number];
type StoppedCall = Extract<BudgetStopStatus, { status: 'stopped' }>['calls'][number];
function emptyTurnBudget(): TurnBudget {
  return { ...emptyBudget(), callPositions: new Map() };
}
function addBudget(state: TurnBudget, row: StoredEvent) {
  applyBudget(state, row.event, row.sequence);
  if (row.event.type === 'budget.reserved') {
    const reservation = state.reservations.at(-1)!;
    state.callPositions.set(reservation.id, row.sequence);
  } else if (row.event.type === 'budget.call_dispatch_admitted') {
    const dispatch = state.dispatches.at(-1)!;
    if (dispatch.reservationId === undefined) state.callPositions.set(dispatch.callId, row.sequence);
  }
}
const turnBudget: SummaryKind<TurnBudget> = {
  name: 'turn-budget-stops', keep: 4, empty: emptyTurnBudget, add: addBudget,
};

export function requireDescendantAllowance(store: EventStore, silo: string,
  binding: Descendant, deadline: number) {
  function check(state: BudgetState) {
    function matches(root: BudgetState['roots'][number]) {
      return root.rootId === binding.rootId;
    }
    const root = state.roots.find(matches);
    if (!root || root.stop || root.turnId !== binding.rootTurnId ||
        root.threadId !== binding.rootThreadId) {
      throw new Error('Descendant allowance refused');
    }
    const fields = ['requesterId', 'conversationId', 'assistantId', 'computerId',
      'generation', 'payingGroupId'] as const;
    for (const field of fields) {
      if (root[field] !== binding[field]) {
        throw new Error('Descendant allowance refused');
      }
    }
  }
  return readStreamSummary(store, silo, `budget-${silo}`, turnBudget, deadline, check);
}

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
  function takeDetails(state: TurnBudget, position: number) {
    const stopId = recordedStopId ?? budgetStopId(state, work, new Date(), admittedAt);
    function hasId(stop: BudgetState['stops'][number]) {
      return stop.id === stopId;
    }
    const saved = state.stops.find(hasId);
    if (stopId && !saved) throw new Error('Saved stop unavailable');
    if (!saved) return { position, stop: undefined, calls: [] };
    function applies(reason: BudgetState['stops'][number]['reasons'][number]) {
      return matchesScope(reason, work);
    }
    const reasons = saved.reasons.filter(applies);
    const stop = structuredClone({ ...saved, reasons });
    const calls = savedCalls(state, work);
    return { position, stop, calls };
  }
  return readStreamSummary(store, silo, `budget-${silo}`, turnBudget, deadline, takeDetails);
}

function callStatus(reservation: Reservation | undefined, dispatched: boolean): StoppedCall['status'] {
  if (reservation?.settledCents !== undefined) {
    if (reservation.outcomeUnknown) return 'possibly_sent';
    if (reservation.outcome === 'not_dispatched') return 'released';
    return 'charged';
  }
  // Treat admission as a possible send even after its permission expires.
  if (dispatched) return 'possibly_sent';
  if (reservation?.expired) return 'released';
  return 'held';
}
function callDetails(reference: string, reservation: Reservation | undefined,
  dispatched: boolean): StoppedCall {
  const status = callStatus(reservation, dispatched);
  if (status === 'charged') return { reference, status, chargedCents: reservation!.settledCents! };
  if (status === 'held' || status === 'possibly_sent') {
    return { reference, status, heldCents: reservation?.amountCents ?? 0 };
  }
  return { reference, status };
}
function savedCalls(state: TurnBudget, work: Parameters<typeof budgetStopId>[1]) {
  const calls: StoppedCall[] = [];
  function matches(call: Reservation['call']) {
    return call.conversationId === work.conversationId && call.turnId === work.turnId;
  }
  for (const reservation of state.reservations) {
    if (!matches(reservation.call)) continue;
    function admitted(dispatch: BudgetState['dispatches'][number]) {
      return dispatch.reservationId === reservation.id;
    }
    const dispatched = state.dispatches.some(admitted);
    const call = callDetails(reservation.id, reservation, dispatched);
    calls.push(call);
  }
  for (const dispatch of state.dispatches) {
    if (dispatch.reservationId !== undefined || !matches(dispatch.modelCall)) continue;
    const call = callDetails(dispatch.callId, undefined, true);
    calls.push(call);
  }
  function earlier(first: StoppedCall, second: StoppedCall) {
    return state.callPositions.get(first.reference)! - state.callPositions.get(second.reference)!;
  }
  calls.sort(earlier);
  return calls;
}
