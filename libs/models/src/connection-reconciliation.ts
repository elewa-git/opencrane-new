import { createHash } from 'node:crypto';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
import type { Db } from '@opencrane/projections';
import { envelope, history } from './actor.ts';
import { foldConnection } from './bearer-connections.ts';
import type { connectionCustody, ConnectionStage } from './connection-custody.ts';
import { withConnectionStage } from './connection-stage-lock.ts';

type Custody = Pick<ReturnType<typeof connectionCustody>, 'recover' | 'remove'>;
const retained = { status: 'retained' as const };

/** Reconcile one private candidate during live maintenance, never during event replay. */
export async function reconcileConnectionStage(store: EventStore, db: Pick<Db, 'lock'>,
  custody: Custody, stage: ConnectionStage) {
  async function reconcile() {
    const recovered = await custody.recover(stage);
    if (recovered.status !== 'recovered' || !recovered.identity || stage.purpose !== 'personal') {
      return retained;
    }
    // Read after acquiring the lock. An earlier snapshot could miss a completed save.
    const subject = `connection-${stage.userId}-${stage.serverId}-${stage.profileId}`;
    let rows = await history(store, subject, stage.siloId, performance.now() + 10_000);
    let state = foldConnection(rows);
    const reference = `secret:${recovered.identity.reference}`;
    if (state.data?.secretRef === reference || Date.now() <= stage.appendUntil) {
      return retained;
    }
    if (state.sequence === stage.expectedSequence) {
      if (!await closeOperation(store, stage, subject, rows)) {
        return retained;
      }
      rows = await history(store, subject, stage.siloId, performance.now() + 10_000);
      state = foldConnection(rows);
    }
    // Require a saved conflict, not a timeout. It defeats even a publish still in flight.
    if (state.sequence <= stage.expectedSequence) {
      return retained;
    }
    const lastType = rows.at(-1)?.event.type;
    if (state.status !== 'saved_unverified' && lastType !== 'connection.revoked' &&
        !state.closedOperations.includes(stage.operationId)) {
      return retained;
    }
    const removed = await custody.remove(stage, recovered.identity);
    if (removed.status !== 'deleted') {
      return retained;
    }
    return { status: 'deleted' as const };
  }
  try {
    return await withConnectionStage(db, stage, reconcile);
  } catch {
    // Keep material and hide dependency errors, which can contain private response bytes.
    return retained;
  }
}

async function closeOperation(store: EventStore, stage: ConnectionStage,
  subject: string, rows: StoredEvent[]) {
  const hash = createHash('sha256');
  hash.update(JSON.stringify([stage.siloId, subject, 'connection.operation_closed',
    stage.operationId]));
  const data = { userId: stage.userId, serverId: stage.serverId, profile: stage.profileId,
    operationId: stage.operationId, generation: stage.generation,
    expectedSequence: stage.expectedSequence, appendUntil: stage.appendUntil,
    reason: 'append_deadline_passed' };
  const event = envelope(stage.siloId, subject, 'connection.operation_closed', data,
    hash.digest('hex'), new Date(Date.now()));
  const proposed = { event, sequence: stage.expectedSequence + 1 };
  const state = foldConnection([...rows, proposed]);
  if (!state.closedOperations.includes(stage.operationId)) {
    return false;
  }
  const command = { event, expectedSequence: stage.expectedSequence,
    historyChecked: true as const, deadline: performance.now() + 10_000 };
  const result = await store.append(command);
  return result.status === 'appended';
}
