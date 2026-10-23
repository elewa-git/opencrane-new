import type { ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { history } from './event-history.ts';
import { data, type BudgetState } from './state.ts';
import type { BudgetActor } from './actor.ts';
import { CallRetryRefused, turnRootId } from './root-budget.ts';
import type { ModelCall } from './state.ts';

type NativeCall = {
  callId: string;
  accessExpiresAt: number;
  rootId: string;
  rootTurn: Pick<ModelCall, 'turnId' | 'threadId'>;
};

export async function grantModelCall(actor: BudgetActor,
  call: ModelCall & { requestId: string }, amountCents: number,
  raw: string, fresh: () => Promise<void>, admittedAt: number | undefined,
  allow: (reservationId: string, requestId: string) => Promise<string>, native?: NativeCall) {
  // Use the verified turn binding; caller headers cannot choose a root.
  const rootId = native?.rootId ?? turnRootId(actor.state, call.conversationId, call.turnId);
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
    let identity = [actor.silo, rootId, call.computerId, call.generation,
      call.conversationId, call.turnId, call.threadId, bodyDigest];
    if (native) {
      // Keep changed bytes or bindings on the same call so the actor refuses replacement holds.
      identity = [actor.silo, 'native', native.callId];
    }
    retryHash.update(JSON.stringify(identity));
    const retryDigest = retryHash.digest('hex');
    const expiry = native ? { accessExpiresAt: native.accessExpiresAt } : {};
    const retry = { retryDigest, bodyDigest, ...expiry };
    const nativeAccess = native ? nativeRetryAccess(actor, retryDigest, native, fresh) : undefined;
    const confirmAccess = nativeAccess?.confirmAccess ?? fresh;
    const reservationId = await actor.reserve(call, amountCents, confirmAccess, admittedAt,
      rootId, retry, native?.rootTurn);
    function matchesReservation(saved: Reservation) {
      return saved.id === reservationId;
    }
    const saved = actor.state.reservations.find(matchesReservation)!;
    const requestId = saved.call.requestId!;
    const decisionId = await recoverDecision(actor, saved, allow,
      nativeAccess?.requireOriginalExpiry);
    const dispatch = { callId: requestId, decisionId, bodyDigest,
      reservationId, modelCall: saved.call, rootId };
    await actor.admitDispatch(dispatch, confirmAccess, admittedAt, native?.rootTurn);
    return { reservationId, requestId };
  } catch {
    // Keep an uncertain hold and its original decision available for a later retry.
    throw new CallRetryRefused();
  }
}

function nativeRetryAccess(actor: BudgetActor, retryDigest: string, native: NativeCall,
  fresh: () => Promise<void>) {
  function matchesRetry(saved: Reservation) {
    return saved.retryDigest === retryDigest;
  }
  function requireOriginalExpiry() {
    // Read the hold again after queue waits; another attempt may have saved it first.
    const saved = actor.state.reservations.find(matchesRetry);
    const expiresAt = saved ? saved.accessExpiresAt : native.accessExpiresAt;
    if (expiresAt === undefined || Date.now() >= expiresAt) {
      throw new CallRetryRefused();
    }
  }
  async function confirmAccess() {
    requireOriginalExpiry();
    await fresh();
    requireOriginalExpiry();
  }
  return { confirmAccess, requireOriginalExpiry };
}

type Reservation = BudgetState['reservations'][number];
async function savedDecision(actor: BudgetActor, saved: Reservation) {
  const requestId = saved.call.requestId!;
  const rows = await history(actor.store, `decision-${requestId}`, actor.silo);
  if (rows.length === 0) {
    return undefined;
  }
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
  allow: (reservationId: string, requestId: string) => Promise<string>,
  requireOriginalExpiry?: () => void) {
  const decisionId = await savedDecision(actor, saved);
  if (decisionId !== undefined) {
    return decisionId;
  }
  // Refuse a missing decision if reading its history used the remaining access time.
  requireOriginalExpiry?.();
  try {
    return await allow(saved.id, saved.call.requestId!);
  } catch {
    // Recover a lost append reply or the decision saved by a concurrent retry.
    const recovered = await savedDecision(actor, saved);
    if (recovered === undefined) {
      throw new CallRetryRefused();
    }
    return recovered;
  }
}

export function refuseCallRetry(error: unknown, response: ServerResponse, auditAttempted: boolean) {
  if (!(error instanceof CallRetryRefused)) {
    return false;
  }
  response.writeHead(auditAttempted ? 503 : 403);
  response.end('{"error":"Model call retry refused"}');
  return true;
}
