import type { EventStore } from '@opencrane/event-store';
import type { Db } from '@opencrane/projections';
import { history } from './actor.ts';
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
    const rows = await history(store, subject, stage.siloId, performance.now() + 10_000);
    const state = foldConnection(rows);
    const reference = `secret:${recovered.identity.reference}`;
    if (state.data?.secretRef === reference || Date.now() <= stage.appendUntil) {
      return retained;
    }
    // Require a saved conflict, not a timeout. It defeats even a publish still in flight.
    if (state.sequence <= stage.expectedSequence) {
      return retained;
    }
    const lastType = rows.at(-1)?.event.type;
    if (state.status !== 'saved_unverified' && lastType !== 'connection.revoked') {
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
