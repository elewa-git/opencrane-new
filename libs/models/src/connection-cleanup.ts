import { isDeepStrictEqual } from 'node:util';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
import { connectionRevokedDataSchema, connectionRefreshedDataSchema,
  type EventEnvelope } from '@opencrane/events';
import { registerHandler } from '@opencrane/handlers';
import type { Db } from '@opencrane/projections';
import { history } from './actor.ts';
import { foldConnection } from './bearer-connections.ts';
import type { connectionCustody, ConnectionStage } from './connection-custody.ts';
import { reconcileConnectionStage } from './connection-reconciliation.ts';

type Custody = Pick<ReturnType<typeof connectionCustody>, 'recover' | 'remove' | 'retire'>;

function confirmedChange(rows: StoredEvent[], trigger: EventEnvelope) {
  function matches(row: StoredEvent) {
    return isDeepStrictEqual(row.event, trigger);
  }
  const index = rows.findIndex(matches);
  if (index < 0) {
    return false;
  }
  const preceding = rows.slice(0, index);
  const previous = foldConnection(preceding);
  if (trigger.type === 'connection.refreshed') {
    const throughChange = rows.slice(0, index + 1);
    return foldConnection(throughChange).data?.activation.operationId === trigger.id;
  }
  const parsed = connectionRevokedDataSchema.safeParse(trigger.data);
  if (parsed.success && previous.data?.activation.reason === 'oauth_confirmed') {
    return 'oauth_revoke';
  }
  return parsed.success && previous.status === 'saved_unverified' &&
    parsed.data.expectedSequence === previous.sequence &&
    parsed.data.reason === 'owner_requested' && parsed.data.revokedBy === parsed.data.userId &&
    trigger.principal?.kind === 'human' && trigger.principal.id === parsed.data.userId;
}

function savedStages(rows: StoredEvent[]) {
  const stages: ConnectionStage[] = [];
  const preceding: StoredEvent[] = [];
  for (const row of rows) {
    preceding.push(row);
    const saved = foldConnection(preceding).data;
    if (!saved || saved.activation.operationId !== row.event.id) {
      continue;
    }
    const activation = saved.activation;
    const stage: ConnectionStage = { siloId: row.event.silo, userId: saved.userId,
      serverId: saved.serverId, profileId: saved.profile, connectionId: activation.connectionId,
      purpose: activation.purpose, generation: activation.generation,
      endpointDigest: activation.endpointDigest, operationId: activation.operationId,
      expectedSequence: activation.expectedSequence, appendUntil: activation.appendUntil };
    stages.push(stage);
  }
  return stages;
}

/** Clean saved replacements in live workers. Replay only rebuilds the connection fold. */
export function connectionCleanupHandler(store: EventStore, db: Pick<Db, 'lock'>,
  custody: Custody, silo: string) {
  async function cleanup(trigger: EventEnvelope) {
    try {
      if (trigger.silo !== silo ||
          !['connection.revoked', 'connection.refreshed'].includes(trigger.type)) {
        return;
      }
      const schema = trigger.type === 'connection.revoked'
        ? connectionRevokedDataSchema : connectionRefreshedDataSchema;
      const parsed = schema.safeParse(trigger.data);
      if (!parsed.success) {
        return;
      }
      const data = parsed.data;
      const subject = `connection-${data.userId}-${data.serverId}-${data.profile}`;
      if (trigger.subject !== subject) {
        return;
      }
      const rows = await history(store, subject, silo, performance.now() + 10_000);
      const confirmed = confirmedChange(rows, trigger);
      // Keep OAuth material for the separate provider revocation and retirement worker.
      if (confirmed === 'oauth_revoke') {
        return;
      }
      if (!confirmed) {
        throw new Error('Connection cleanup unavailable');
      }
      const current = foldConnection(rows).data?.activation.operationId;
      const stages = savedStages(rows);
      for (const stage of stages) {
        if (stage.operationId === current) {
          continue;
        }
        // Recheck under the profile lock; the queue's earlier read grants no deletion right.
        const result = await reconcileConnectionStage(store, db, custody, stage);
        if (result.status === 'retained') {
          throw new Error('Connection cleanup unavailable');
        }
      }
    } catch {
      // Keep private transport errors out of queue diagnostics. Let the runtime retry.
      throw new Error('Connection cleanup unavailable');
    }
  }
  return registerHandler('cleanup-connection', cleanup);
}
