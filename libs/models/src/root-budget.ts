import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { budgetRootAllowanceSetDataSchema, type budgetRootStoppedDataSchema } from '@opencrane/events';
import { budgetStopId, exceededReasons, type BudgetState, type ModelCall } from './state.ts';

type Append = (type: string, payload: unknown) => Promise<void>;
type Root = BudgetState['roots'][number];
const allowanceInput = budgetRootAllowanceSetDataSchema.omit({ rootId: true });
type RefusalReason = z.infer<typeof budgetRootStoppedDataSchema>['reason'] |
  'allowance_unavailable';
export class RootBudgetRefused extends Error {
  readonly reason: RefusalReason;
  readonly availableCents: number;
  constructor(reason: RefusalReason, availableCents: number) {
    super('Root budget refused');
    this.reason = reason;
    this.availableCents = availableCents;
  }
}
function rootIdentity(silo: string, conversationId: string, turnId: string) {
  const hash = createHash('sha256');
  hash.update(JSON.stringify([silo, conversationId, turnId]));
  return hash.digest('hex');
}
export function rootTotals(state: BudgetState, rootId: string) {
  const root = findRoot(state, rootId);
  let settled = 0n;
  let held = 0n;
  for (const reservation of state.reservations) {
    if (reservation.rootId !== rootId) continue;
    settled += BigInt(reservation.settledCents ?? 0);
    if (reservation.settledCents === undefined || reservation.outcomeUnknown) {
      held += BigInt(reservation.amountCents);
    }
  }
  if (settled > BigInt(Number.MAX_SAFE_INTEGER) || held > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('Root total overflow');
  }
  const remaining = BigInt(root.allowanceCents) - settled - held;
  const availableCents = Number(remaining > 0n ? remaining : 0n);
  return { settledCents: Number(settled), heldCents: Number(held), availableCents };
}
function findRoot(state: BudgetState, rootId: string) {
  function matches(root: Root) {
    return root.rootId === rootId;
  }
  const root = state.roots.find(matches);
  if (!root) throw new Error('Root binding conflict');
  return root;
}
function remainingCapacity(state: BudgetState, binding: z.infer<typeof allowanceInput>, now: Date) {
  const limits = exceededReasons(state, binding, now, Number.MAX_SAFE_INTEGER);
  let remaining = 1000n;
  for (const limit of limits) {
    const available = BigInt(limit.ceilingCents) - BigInt(limit.settledCents) -
      BigInt(limit.reservedCents);
    if (available < remaining) remaining = available;
  }
  return Number(remaining > 0n ? remaining : 0n);
}
export async function setRootAllowance(state: BudgetState, silo: string, now: Date,
  raw: unknown, firstCallBoundCents: number, append: Append) {
  const parsed = allowanceInput.safeParse(raw);
  if (!parsed.success || !z.int().positive().safeParse(firstCallBoundCents).success) {
    throw new Error('Invalid root allowance');
  }
  const binding = parsed.data;
  const rootId = rootIdentity(silo, binding.conversationId, binding.turnId);
  const payload = { ...binding, rootId };
  function matches(root: Root) {
    return root.rootId === rootId;
  }
  const prior = state.roots.find(matches);
  if (prior) {
    const saved = budgetRootAllowanceSetDataSchema.strip().parse(prior);
    if (!isDeepStrictEqual(saved, payload)) throw new Error('Root binding conflict');
    return prior;
  }
  for (const reservation of state.reservations) {
    if (reservation.call.conversationId === binding.conversationId &&
        reservation.call.turnId === binding.turnId) {
      throw new Error('Root binding conflict');
    }
  }
  const availableCents = remainingCapacity(state, binding, now);
  if (budgetStopId(state, binding, now) !== undefined) {
    throw new RootBudgetRefused('ceiling_stop', availableCents);
  }
  if (binding.allowanceCents > availableCents || firstCallBoundCents > binding.allowanceCents) {
    throw new RootBudgetRefused('allowance_unavailable',
      Math.min(availableCents, binding.allowanceCents));
  }
  await append('budget.root_allowance_set', payload);
  return findRoot(state, rootId);
}
async function stopRoot(state: BudgetState,
  payload: z.infer<typeof budgetRootStoppedDataSchema>, append: Append) {
  const root = findRoot(state, payload.rootId);
  if (!root.stop) await append('budget.root_stopped', payload);
  const availableCents = rootTotals(state, root.rootId).availableCents;
  throw new RootBudgetRefused(root.stop!.reason, availableCents);
}
export async function stopRootAtCeiling(state: BudgetState, root: Root | undefined,
  stopId: string, append: Append) {
  if (!root) return;
  const stop = { rootId: root.rootId, reason: 'ceiling_stop' as const, stopId };
  await stopRoot(state, stop, append);
}
export async function stopRootOnOverrun(state: BudgetState,
  reservation: BudgetState['reservations'][number], settledCents: number, append: Append) {
  if (reservation.rootId === undefined || settledCents <= reservation.amountCents) return;
  const root = findRoot(state, reservation.rootId);
  if (root.stop) return;
  const stop = { rootId: root.rootId, reason: 'budget_reservation_exceeded' as const,
    reservationId: reservation.id };
  await append('budget.root_stopped', stop);
}
export async function checkRootReservation(state: BudgetState, call: ModelCall,
  rootId: string | undefined, amountCents: number, append: Append) {
  function matchesTurn(root: Root) {
    return root.conversationId === call.conversationId && root.turnId === call.turnId;
  }
  const root = state.roots.find(matchesTurn);
  if (!root && rootId === undefined) return undefined;
  if (!root || root.rootId !== rootId) throw new Error('Root binding conflict');
  const fields = ['requesterId', 'threadId', 'assistantId', 'computerId', 'generation',
    'payingGroupId'] as const;
  for (const field of fields) {
    if (root[field] !== call[field]) throw new Error('Root binding conflict');
  }
  const availableCents = rootTotals(state, root.rootId).availableCents;
  if (root.stop) throw new RootBudgetRefused(root.stop.reason, availableCents);
  if (amountCents > availableCents) {
    const stop = { rootId: root.rootId, reason: 'allowance_exhausted' as const,
      attemptedBoundCents: amountCents, availableCents };
    await stopRoot(state, stop, append);
  }
  return root;
}
