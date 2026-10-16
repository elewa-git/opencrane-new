import { createHash } from 'node:crypto';
import type { BudgetActor } from './actor.ts';
import { turnRootId } from './root-budget.ts';
import type { ModelCall } from './state.ts';

export async function grantModelCall(actor: BudgetActor,
  call: ModelCall & { requestId: string }, amountCents: number,
  raw: string, fresh: () => Promise<void>, admittedAt: number,
  allow: (reservationId: string) => Promise<string>) {
  // Use the verified turn binding; caller headers cannot choose a root.
  const rootId = turnRootId(actor.state, call.conversationId, call.turnId);
  const reservationId = await actor.reserve(call, amountCents, fresh, admittedAt, rootId);
  const decisionId = await allow(reservationId);
  const bodyHash = createHash('sha256');
  bodyHash.update(raw);
  const dispatch = { callId: call.requestId, decisionId, bodyDigest: bodyHash.digest('hex'),
    reservationId, modelCall: call, ...(rootId === undefined ? {} : { rootId }) };
  await actor.admitDispatch(dispatch, fresh, admittedAt);
  return reservationId;
}
