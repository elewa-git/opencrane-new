import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { StoredEvent } from '@opencrane/event-store';
import { connectionOAuthExchangeClaimedDataSchema,
  type connectionCreatedDataSchema } from '@opencrane/events';
import type { z } from 'zod';

type Created = z.infer<typeof connectionCreatedDataSchema>;
type Saved = Created & { activation: NonNullable<Created['activation']> };
type State = { sequence: number; data?: Saved;
  refreshAttempt?: StoredEvent; refreshClaim?: StoredEvent };

export function connectionOperationId(silo: string, subject: string, changeRef: string) {
  const hash = createHash('sha256');
  hash.update(JSON.stringify([silo, subject, changeRef]));
  return hash.digest('hex');
}

/** Rebuild a replacement only after its matching attempt and claim, without private effects. */
export function refreshedOAuth(previous: State, row: StoredEvent, data: Saved, silo?: string) {
  const claim = previous.refreshClaim;
  const attempt = previous.refreshAttempt;
  const saved = previous.data;
  const before = saved?.activation;
  const after = data.activation;
  if (!claim || !attempt || !saved || before?.reason !== 'oauth_confirmed' ||
      after.reason !== 'oauth_confirmed' || row.event.type !== 'connection.refreshed') {
    return false;
  }
  const resultId = connectionOperationId(row.event.silo, row.event.subject,
    `${claim.event.id}-result`);
  const operationId = connectionOperationId(row.event.silo, row.event.subject,
    `${resultId}-confirm`);
  const claimed = connectionOAuthExchangeClaimedDataSchema.parse(claim.event.data);
  const account = { ...before.account, expiresAt: after.account.expiresAt };
  const activation = { ...after, connectionId: before.connectionId,
    generation: before.generation + 1, endpointDigest: before.endpointDigest, operationId,
    expectedSequence: claim.sequence, appendUntil: claimed.appendUntil,
    configurationDigest: before.configurationDigest, account };
  const expected = { ...data, userId: saved.userId, serverId: saved.serverId,
    profile: saved.profile, activation };
  return row.event.silo === silo && row.event.source === 'opencrane-server' &&
    row.sequence > claim.sequence && previous.sequence === claim.sequence &&
    row.event.commandId === attempt.event.commandId && isDeepStrictEqual(data, expected);
}
