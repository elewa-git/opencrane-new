import type { EventStore } from '@opencrane/event-store';
import { history } from './event-history.ts';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { budgetRootAllowanceSetDataSchema, type budgetCallDispatchAdmittedDataSchema,
  type budgetRootStoppedDataSchema } from '@opencrane/events';
import { budgetStopId, exceededReasons, requireDispatchReservation,
  type BudgetState, type ModelCall } from './state.ts';

type Append = (type: string, payload: unknown) => Promise<void>;
type Root = BudgetState['roots'][number];
type Reservation = BudgetState['reservations'][number];
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
export function turnRootId(state: BudgetState, conversationId: string, turnId: string) {
  function matchesTurn(root: Root) {
    return root.conversationId === conversationId && root.turnId === turnId;
  }
  return state.roots.find(matchesTurn)?.rootId;
}
export function turnRootBinding(state: BudgetState, conversationId: string,
  turnId: string): { rootId?: string } {
  const rootId = turnRootId(state, conversationId, turnId);
  if (rootId === undefined) {
    return {};
  }
  return { rootId };
}
function bindDispatchRoot(state: BudgetState,
  input: z.infer<typeof budgetCallDispatchAdmittedDataSchema>) {
  if (input.rootId !== undefined || input.reservationId === undefined) {
    return input;
  }
  function matchesHold(hold: BudgetState['reservations'][number]) {
    return hold.id === input.reservationId;
  }
  // Preserve internal callers made before dispatch records carried the hold's root.
  const rootId = state.reservations.find(matchesHold)?.rootId;
  if (rootId === undefined) {
    return input;
  }
  return { ...input, rootId };
}
export async function checkRootReservation(state: BudgetState, call: ModelCall,
  rootId: string | undefined, amountCents: number, append: Append,
  rootTurn?: Pick<ModelCall, 'turnId' | 'threadId'>, fresh?: () => Promise<void>) {
  // Use only the checked native root here; keep the child's own identifiers on the hold.
  if (rootTurn !== undefined) {
    if (!fresh) {
      throw new Error('Descendant access check required');
    }
    // Recheck access before a capacity refusal can stop the root.
    await fresh();
  }
  const rootCall = rootTurn === undefined ? call :
    { ...call, turnId: rootTurn.turnId, threadId: rootTurn.threadId };
  function matchesTurn(root: Root) {
    return root.conversationId === rootCall.conversationId && root.turnId === rootCall.turnId;
  }
  const root = state.roots.find(matchesTurn);
  if (!root && rootId === undefined) return undefined;
  if (!root || root.rootId !== rootId) throw new Error('Root binding conflict');
  const fields = ['requesterId', 'threadId', 'assistantId', 'computerId', 'generation',
    'payingGroupId'] as const;
  for (const field of fields) {
    if (root[field] !== rootCall[field]) throw new Error('Root binding conflict');
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

export async function checkRootDispatch(state: BudgetState,
  input: z.infer<typeof budgetCallDispatchAdmittedDataSchema>, now: Date,
  fresh: () => Promise<void>, append: Append, release: (id: string) => Promise<void>,
  admittedAt: number | undefined, rootTurn?: Pick<ModelCall, 'turnId' | 'threadId'>) {
  // Order Stop and dispatch in the actor queue, after checking current access.
  try {
    return await checkRootGrant(state, input.modelCall, input.rootId, now, fresh,
      append, admittedAt, rootTurn);
  } catch (error) {
    // Release only through the existing proof that no send or usage was recorded.
    if (input.reservationId !== undefined) {
      await release(input.reservationId);
    }
    throw error;
  }
}

export async function checkRootGrant(state: BudgetState, call: ModelCall,
  rootId: string | undefined, now: Date, fresh: (() => Promise<void>) | undefined, append: Append,
  admittedAt: number | undefined, rootTurn?: Pick<ModelCall, 'turnId' | 'threadId'>) {
  const turnRoot = turnRootId(state, call.conversationId, rootTurn?.turnId ?? call.turnId);
  if (rootId === undefined && turnRoot === undefined) {
    return admittedAt;
  }
  await fresh?.();
  const root = await checkRootReservation(state, call, rootId, 0, append, rootTurn, fresh);
  let stopId = budgetStopId(state, call, now, root?.position);
  if (stopId === undefined) {
    const reasons = exceededReasons(state, call, now, 0);
    if (reasons.length > 0) {
      const work = { conversationId: call.conversationId, turnId: call.turnId };
      const exhaustion = { reasons, work };
      await append('budget.exhausted', exhaustion);
      stopId = budgetStopId(state, call, now, root?.position);
    }
  }
  if (stopId !== undefined) {
    await stopRootAtCeiling(state, root, stopId, append);
  }
  return root?.position;
}

export function checkDispatchBinding(state: BudgetState,
  parsed: z.infer<typeof budgetCallDispatchAdmittedDataSchema>) {
  const input = bindDispatchRoot(state, parsed);
  function matchesDispatch(saved: BudgetState['dispatches'][number]) {
    return saved.callId === input.callId ||
      (input.reservationId !== undefined && saved.reservationId === input.reservationId);
  }
  if (state.dispatches.some(matchesDispatch)) {
    throw new Error('Call already admitted; no further send permission');
  }
  requireDispatchReservation(state, input);
  return input;
}

export function wasAdmitted(state: BudgetState, reservationId: string) {
  function matchesDispatch(saved: BudgetState['dispatches'][number]) {
    return saved.reservationId === reservationId;
  }
  return state.dispatches.some(matchesDispatch);
}

export type CallRetry = { retryDigest: string; bodyDigest: string };
export class CallRetryRefused extends Error {
  constructor() {
    super('Model call retry refused');
  }
}
export async function retryReservation(state: BudgetState, call: ModelCall,
  amountCents: number, rootId: string | undefined, retry: CallRetry | undefined,
  hasEvidence: (reservation: Reservation) => Promise<boolean>, fresh?: () => Promise<void>) {
  if (retry === undefined) {
    return undefined;
  }
  if (rootId === undefined || call.requestId === undefined) {
    throw new CallRetryRefused();
  }
  function matchesRetry(saved: Reservation) {
    return saved.retryDigest === retry?.retryDigest;
  }
  const saved = state.reservations.find(matchesRetry);
  if (!saved) {
    return undefined;
  }
  const originalCall = { ...call, requestId: saved.call.requestId };
  const bindingMatches = saved.rootId === rootId && saved.bodyDigest === retry.bodyDigest &&
    saved.amountCents === amountCents && isDeepStrictEqual(saved.call, originalCall);
  if (!bindingMatches || saved.settledCents !== undefined || saved.expired || saved.outcomeUnknown) {
    throw new CallRetryRefused();
  }
  await fresh?.();
  if (await hasEvidence(saved)) {
    throw new CallRetryRefused();
  }
  return saved.id;
}

export async function hasCallEvidence(store: EventStore, silo: string, reservationId: string) {
  const effects = await history(store, `effect-${reservationId}`, silo);
  const security = await history(store, `security-${reservationId}`, silo);
  return effects.length > 0 || security.length > 0;
}
