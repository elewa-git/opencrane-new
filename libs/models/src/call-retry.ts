import type { ServerResponse } from 'node:http';
import type { EventStore } from '@opencrane/event-store';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { history } from './event-history.ts';
import { data, type BudgetState } from './state.ts';
import type { BudgetActor } from './actor.ts';
import { turnRootId } from './root-budget.ts';
import type { ModelCall } from './state.ts';

export async function grantModelCall(actor: BudgetActor,
  call: ModelCall & { requestId: string }, amountCents: number,
  raw: string, fresh: () => Promise<void>, admittedAt: number,
  allow: (reservationId: string, requestId: string) => Promise<string>) {
  // Use the verified turn binding; caller headers cannot choose a root.
  const rootId = turnRootId(actor.state, call.conversationId, call.turnId);
  const bodyHash = createHash('sha256');
  bodyHash.update(raw);
  const bodyDigest = bodyHash.digest('hex');
  if (rootId === undefined) {
    const reservationId = await actor.reserve(call, amountCents, fresh, admittedAt);
    let decisionId: string;
    try {
      decisionId = await allow(reservationId, call.requestId);
    } catch (error) {
      await actor.releaseUndispatched(reservationId);
      throw error;
    }
    const dispatch = { callId: call.requestId, decisionId, bodyDigest,
      reservationId, modelCall: call };
    await actor.admitDispatch(dispatch, fresh, admittedAt);
    return { reservationId, requestId: call.requestId };
  }
  try {
    const retryHash = createHash('sha256');
    retryHash.update(JSON.stringify([actor.silo, rootId, call.computerId, call.generation,
      call.conversationId, call.turnId, call.threadId, bodyDigest]));
    const retry = { retryDigest: retryHash.digest('hex'), bodyDigest };
    const reservationId = await actor.reserve(call, amountCents, fresh, admittedAt, rootId, retry);
    function matchesReservation(saved: Reservation) { return saved.id === reservationId; }
    const saved = actor.state.reservations.find(matchesReservation)!;
    const requestId = saved.call.requestId!;
    const decisionId = await recoverDecision(actor, saved, allow);
    const dispatch = { callId: requestId, decisionId, bodyDigest,
      reservationId, modelCall: saved.call, rootId };
    await actor.admitDispatch(dispatch, fresh, admittedAt);
    return { reservationId, requestId };
  } catch {
    // Keep an uncertain hold and its original decision available for a later retry.
    throw new CallRetryRefused();
  }
}

type Reservation = BudgetState['reservations'][number];
export type CallRetry = { retryDigest: string; bodyDigest: string };
class CallRetryRefused extends Error {
  constructor() { super('Model call retry refused'); }
}
export async function retryReservation(state: BudgetState, call: ModelCall,
  amountCents: number, rootId: string | undefined, retry: CallRetry | undefined,
  hasEvidence: (reservation: Reservation) => Promise<boolean>, fresh?: () => Promise<void>) {
  if (retry === undefined) return undefined;
  if (rootId === undefined || call.requestId === undefined) throw new CallRetryRefused();
  function matchesRetry(saved: Reservation) { return saved.retryDigest === retry?.retryDigest; }
  const saved = state.reservations.find(matchesRetry);
  if (!saved) return undefined;
  const originalCall = { ...call, requestId: saved.call.requestId };
  const bindingMatches = saved.rootId === rootId && saved.bodyDigest === retry.bodyDigest &&
    saved.amountCents === amountCents && isDeepStrictEqual(saved.call, originalCall);
  if (!bindingMatches || saved.settledCents !== undefined || saved.expired || saved.outcomeUnknown) {
    throw new CallRetryRefused();
  }
  await fresh?.();
  if (await hasEvidence(saved)) throw new CallRetryRefused();
  return saved.id;
}
async function savedDecision(actor: BudgetActor, saved: Reservation) {
  const requestId = saved.call.requestId!;
  const rows = await history(actor.store, `decision-${requestId}`, actor.silo);
  if (rows.length === 0) return undefined;
  const event = rows[0]!.event;
  const decision = data(event);
  if (rows.length !== 1 || event.type !== 'decision.recorded' ||
      decision['outcome'] !== 'allow' || decision['requestId'] !== requestId ||
      decision['permitId'] !== saved.id || decision['contextDigest'] !== saved.call.contextDigest) {
    throw new CallRetryRefused();
  }
  return event.id;
}
async function recoverDecision(actor: BudgetActor, saved: Reservation,
  allow: (reservationId: string, requestId: string) => Promise<string>) {
  const decisionId = await savedDecision(actor, saved);
  if (decisionId !== undefined) return decisionId;
  try {
    return await allow(saved.id, saved.call.requestId!);
  } catch {
    // Recover a lost append reply or the decision saved by a concurrent retry.
    const recovered = await savedDecision(actor, saved);
    if (recovered === undefined) throw new CallRetryRefused();
    return recovered;
  }
}

export async function hasCallEvidence(store: EventStore, silo: string, reservationId: string) {
  const effects = await history(store, `effect-${reservationId}`, silo);
  const security = await history(store, `security-${reservationId}`, silo);
  return effects.length > 0 || security.length > 0;
}
export function refuseCallRetry(error: unknown, response: ServerResponse, auditAttempted: boolean) {
  if (!(error instanceof CallRetryRefused)) return false;
  response.writeHead(auditAttempted ? 503 : 403);
  response.end('{"error":"Model call retry refused"}');
  return true;
}
