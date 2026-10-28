import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import type { StoredEvent } from '@opencrane/event-store';
import { connectionOperationId, foldConnection } from './bearer-connections.ts';
import type { connectionCustody, ConnectionStage } from './connection-custody.ts';

type Custody = ReturnType<typeof connectionCustody>;
type Identity = Parameters<Custody['retire']>[1];
const accessSchema = z.object({ access_token: z.string().regex(/^[\x21-\x7e]{1,4096}$/u) });

/** Keep one access-only copy tied to the original saved generation. */
export function retainedAccessStage(generation: ConnectionStage,
  expiresAt: number): ConnectionStage {
  const subject = `connection-${generation.userId}-${generation.serverId}-${generation.profileId}`;
  const operationId = connectionOperationId(generation.siloId, subject,
    `${generation.operationId}-retained-access`);
  return { ...generation, generation: 1, operationId, attemptId: operationId,
    attemptDigest: generation.endpointDigest, appendUntil: expiresAt };
}

export async function readRetainedAccess(custody: Custody, generation: ConnectionStage,
  expiresAt: number) {
  const stage = retainedAccessStage(generation, expiresAt);
  const recovered = await custody.recover(stage);
  if (recovered.status !== 'recovered' || !recovered.identity) {
    throw new Error('OAuth retained access unavailable');
  }
  const contents = await custody.readAttempt(stage, recovered.identity);
  if (contents === undefined) {
    throw new Error('OAuth retained access unavailable');
  }
  return accessSchema.parse(JSON.parse(contents)).access_token;
}

/** Save the still-live access token before deleting either old refresh-token copy. */
export async function retainAccessToken(custody: Custody, generation: ConnectionStage,
  identity: Identity, expiresAt: number) {
  const contents = await custody.readRevocationMaterial(generation, identity);
  if (contents === undefined) {
    // Require the earlier retained copy when deletion already removed the original.
    await readRetainedAccess(custody, generation, expiresAt);
    return;
  }
  const access = accessSchema.parse(JSON.parse(contents));
  const stage = retainedAccessStage(generation, expiresAt);
  const saved = await custody.stage(stage, JSON.stringify(access));
  if (!saved.identity || !['staged', 'recovered'].includes(saved.status)) {
    throw new Error('OAuth access retention unconfirmed');
  }
}

function isExpiredRetainedAccess(rows: StoredEvent[], candidate: ConnectionStage) {
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!;
    if (!['connection.created', 'connection.refreshed'].includes(row.event.type)) {
      continue;
    }
    const saved = foldConnection(rows.slice(0, index + 1)).data;
    const activation = saved?.activation;
    if (!saved || activation?.reason !== 'oauth_confirmed' ||
        activation.operationId !== row.event.id || Date.now() < activation.account.expiresAt) {
      continue;
    }
    const generation: ConnectionStage = { siloId: row.event.silo, userId: saved.userId,
      serverId: saved.serverId, connectionId: activation.connectionId,
      profileId: saved.profile, purpose: activation.purpose,
      generation: activation.generation, endpointDigest: activation.endpointDigest,
      operationId: activation.operationId, expectedSequence: activation.expectedSequence,
      appendUntil: activation.appendUntil };
    const retained = retainedAccessStage(generation, activation.account.expiresAt);
    if (isDeepStrictEqual(candidate, retained)) {
      return true;
    }
  }
  return false;
}

/** Delete only the access-only copy whose saved account proves its expiry. */
export async function retireExpiredAccess(custody: Pick<Custody, 'recover' | 'retire'>,
  rows: StoredEvent[], candidate: ConnectionStage) {
  const retained = { status: 'retained' as const };
  if (!isExpiredRetainedAccess(rows, candidate)) {
    return retained;
  }
  const recovered = await custody.recover(candidate);
  if (recovered.status !== 'recovered' || !recovered.identity) {
    return retained;
  }
  const removed = await custody.retire(candidate, recovered.identity);
  if (removed.status !== 'deleted') {
    return retained;
  }
  return { status: 'deleted' as const };
}
