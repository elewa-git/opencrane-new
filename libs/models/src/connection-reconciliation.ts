import { createHash } from 'node:crypto';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
import { connectionCreatedDataSchema } from '@opencrane/events';
import type { Db } from '@opencrane/projections';
import { envelope, history } from './actor.ts';
import { foldConnection } from './bearer-connections.ts';
import type { connectionCustody, ConnectionStage, CustodyStage } from './connection-custody.ts';
import { withConnectionStage } from './connection-stage-lock.ts';
import { retireExpiredAccess } from './oauth-retained-access.ts';

type Custody = Pick<ReturnType<typeof connectionCustody>, 'recover' | 'remove' | 'retire'>;
const retained = { status: 'retained' as const };

/** Reconcile one private candidate during live maintenance, never during event replay. */
export async function reconcileConnectionStage(store: EventStore, db: Pick<Db, 'lock'>,
  custody: Custody, input: CustodyStage) {
  if (input.purpose === 'company') {
    return retained;
  }
  const stage = input;
  // Keep private attempts until their deadline, then check whether they hold expired access.
  if (stage.attemptId !== undefined && Date.now() < stage.appendUntil) {
    return retained;
  }
  async function reconcile() {
    // Read under the lock before rebuilding missing private records from saved identities.
    const subject = `connection-${stage.userId}-${stage.serverId}-${stage.profileId}`;
    let rows = await history(store, subject, stage.siloId, performance.now() + 10_000);
    if (stage.attemptId !== undefined) {
      return retireExpiredAccess(custody, rows, stage);
    }
    // Leave OAuth copies to their worker, which must contact the provider before retirement.
    if (rows.some(isOAuthGeneration)) {
      return retained;
    }
    const original = savedIdentity(rows, stage);
    const recovered = await custody.recover(stage, original);
    if (recovered.status === 'not_found' && original) {
      return { status: 'absent' as const };
    }
    if (recovered.status !== 'recovered' || !recovered.identity || stage.purpose !== 'personal') {
      return retained;
    }
    let state = foldConnection(rows);
    const reference = `secret:${recovered.identity.reference}`;
    // A saved activation already occupies its append position, even before the deadline.
    if (currentOrPending(state, reference, stage, original !== undefined)) {
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
    if (!hasSavedConflict(state, rows, stage)) {
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

function hasSavedConflict(state: ReturnType<typeof foldConnection>, rows: StoredEvent[],
  stage: ConnectionStage) {
  if (state.sequence <= stage.expectedSequence) {
    return false;
  }
  const lastType = rows.at(-1)?.event.type;
  return state.status === 'saved_unverified' || lastType === 'connection.revoked' ||
    state.closedOperations.includes(stage.operationId);
}

function isOAuthGeneration(row: StoredEvent) {
  const parsed = connectionCreatedDataSchema.safeParse(row.event.data);
  return parsed.success && parsed.data.activation?.reason === 'oauth_confirmed';
}

function currentOrPending(state: ReturnType<typeof foldConnection>, reference: string,
  stage: ConnectionStage, confirmed: boolean) {
  if (state.data?.secretRef === reference) {
    return true;
  }
  return !confirmed && Date.now() <= stage.appendUntil;
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

function savedIdentity(rows: StoredEvent[], stage: ConnectionStage) {
  function originalOperation(row: StoredEvent) {
    return row.event.id === stage.operationId;
  }
  const index = rows.findIndex(originalOperation);
  if (index < 0) {
    return undefined;
  }
  const preceding = rows.slice(0, index + 1);
  const saved = foldConnection(preceding).data;
  if (!saved || saved.activation.operationId !== stage.operationId) {
    return undefined;
  }
  const activation = saved.activation;
  const recorded = { siloId: rows[index]!.event.silo, userId: saved.userId,
    serverId: saved.serverId, profileId: saved.profile, connectionId: activation.connectionId,
    purpose: activation.purpose, generation: activation.generation,
    endpointDigest: activation.endpointDigest, operationId: activation.operationId,
    expectedSequence: activation.expectedSequence, appendUntil: activation.appendUntil };
  const supplied: Record<string, unknown> = stage;
  for (const [field, value] of Object.entries(recorded)) {
    if (value !== supplied[field]) {
      return undefined;
    }
  }
  return { reference: saved.secretRef.slice('secret:'.length), uid: activation.uid,
    resourceVersion: activation.resourceVersion };
}

/** Advance one bounded live scan. Keep the continuation private and retry failed pages unchanged. */
export async function reconcileConnectionPage(store: EventStore, db: Pick<Db, 'lock'>,
  custody: Custody & Pick<ReturnType<typeof connectionCustody>, 'candidates'>,
  silo: string, continuation?: string) {
  try {
    const page = await custody.candidates(continuation);
    if (page.status !== 'listed') {
      return { status: 'unknown' as const };
    }
    let deleted = 0;
    for (const stage of page.stages) {
      // Keep other silos' copies without consulting this worker's event store or journal.
      if (stage.siloId !== silo) {
        continue;
      }
      const result = await reconcileConnectionStage(store, db, custody, stage);
      if (result.status === 'deleted') {
        deleted += 1;
      }
    }
    return { status: 'scanned' as const, examined: page.stages.length,
      deleted, continuation: page.continuation };
  } catch {
    return { status: 'unknown' as const };
  }
}
