import { isDeepStrictEqual } from 'node:util';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
import { budgetCeilingSetDataSchema } from '@opencrane/events';
import { history } from './event-history.ts';
import { applyBudget, emptyBudget, type BudgetState } from './state.ts';

export function ceilingReceipt(row: StoredEvent, state: BudgetState) {
  const payload = budgetCeilingSetDataSchema.parse(row.event.data);
  function matchesStop(stop: BudgetState['stops'][number]) {
    return stop.id === row.event.id;
  }
  const savedStop = state.stops.find(matchesStop);
  // Report the saved stop request, never completion without termination evidence.
  const stop = savedStop
    ? { status: 'stopping', stopId: savedStop.id }
    : { status: 'not_recorded' };
  const receipt = { commandId: row.event.commandId, eventId: row.event.id,
    sequence: row.sequence, time: row.event.time, ...payload, stop };
  return { status: 'appended' as const, receipt };
}

export function ceilingReceiptFromHistory(row: StoredEvent, rows: StoredEvent[]) {
  const state = emptyBudget();
  for (const saved of rows) applyBudget(state, saved.event, saved.sequence);
  return ceilingReceipt(row, state);
}

export async function prepareCeilingChange(
  actor: { store: EventStore; silo: string; state: BudgetState },
  raw: unknown, commandId: string,
  fresh?: (newCommand?: boolean) => Promise<void>, deadline = performance.now() + 10_000,
) {
  const payload = budgetCeilingSetDataSchema.parse(raw);
  const subject = `budget-${actor.silo}`;
  const rows = await history(actor.store, subject, actor.silo, deadline);
  function matchesCommand(row: StoredEvent) {
    return row.event.commandId === commandId;
  }
  const prior = rows.find(matchesCommand);
  let receipt: ReturnType<typeof ceilingReceipt> | undefined;
  if (prior?.event.type === 'budget.ceiling_set' && prior.event.subject === subject &&
      isDeepStrictEqual(prior.event.data, payload)) {
    // Read the saved stop too; a replacement writer may have recorded this change.
    receipt = ceilingReceiptFromHistory(prior, rows);
  }
  // Start the caller's write check only after reading history.
  // Keep saved retries independent of choices that have since become unavailable.
  await fresh?.(!prior);
  if (prior) return receipt ?? { status: 'conflict' as const };
  const sequence = rows.at(-1)?.sequence ?? 0;
  return { status: 'ready' as const, payload, sequence };
}

export async function readQueuedCeilingReceipt(
  actor: { store: EventStore; silo: string; state: BudgetState },
  payload: unknown, commandId: string, preparedSequence: number, deadline: number,
) {
  if (preparedSequence >= actor.state.sequence) return undefined;
  const subject = `budget-${actor.silo}`;
  // Read only writes applied since preparation; keep full history outside the access deadline.
  const rows = actor.store.readStream(subject, preparedSequence + 1, deadline);
  for await (const row of rows) {
    if (row.event.silo !== actor.silo || row.event.subject !== subject) {
      throw new Error('Budget receipt mismatch');
    }
    if (row.sequence > actor.state.sequence) break;
    if (row.event.commandId !== commandId) continue;
    if (row.event.type === 'budget.ceiling_set' && isDeepStrictEqual(row.event.data, payload)) {
      return ceilingReceipt(row, actor.state);
    }
    return { status: 'conflict' as const };
  }
  return undefined;
}
