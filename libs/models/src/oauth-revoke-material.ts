import { z } from 'zod';
import type { StoredEvent } from '@opencrane/event-store';
import { connectionOAuthExchangeClaimedDataSchema } from '@opencrane/events';
import { connectionOperationId, foldConnection } from './bearer-connections.ts';
import type { connectionCustody, ConnectionStage } from './connection-custody.ts';
import type { oauthConfigurationSchema } from './oauth-attempt.ts';
import { verifyRefreshResult } from './oauth-refresh-worker.ts';

type Custody = ReturnType<typeof connectionCustody>;
type Configuration = z.infer<typeof oauthConfigurationSchema>;
type Material = { revokeToken: string; tokenTypeHint: 'refresh_token' | 'access_token' };
const token = z.string().regex(/^[\x21-\x7e]{1,4096}$/u);
const tokensSchema = z.object({ access_token: token, refresh_token: token.optional() });

function tokens(contents: string | undefined) {
  if (contents === undefined) {
    throw new Error('OAuth revocation material unavailable');
  }
  return tokensSchema.parse(JSON.parse(contents));
}

/** Resolve exact saved copies before sending or deleting any token. */
export async function resolveRevocationTokens(custody: Custody, rows: StoredEvent[],
  generation: ConnectionStage, configuration: Configuration) {
  const state = foldConnection(rows);
  const saved = state.data!;
  const activation = saved.activation;
  if (activation.reason !== 'oauth_confirmed') {
    throw new Error('OAuth revocation generation unavailable');
  }
  const identity = { reference: saved.secretRef.slice('secret:'.length),
    uid: activation.uid, resourceVersion: activation.resourceVersion };
  const current = tokens(await custody.readRevocationMaterial(generation, identity));
  let latest = current;
  const claimed = state.refreshClaim;
  if (claimed) {
    const claim = connectionOAuthExchangeClaimedDataSchema.parse(claimed.event.data);
    const operationId = connectionOperationId(generation.siloId, claimed.event.subject,
      `${claimed.event.id}-result`);
    const resultStage = { ...generation, generation: 1, operationId, attemptId: operationId,
      attemptDigest: activation.configurationDigest, expectedSequence: claimed.sequence,
      appendUntil: claim.appendUntil };
    // Keep an unresolved send unknown. A missing reply does not prove the old token survived.
    if (await custody.hasSendClaim(resultStage)) {
      const recovered = await custody.recover(resultStage);
      if (recovered.status !== 'recovered' || !recovered.identity || !current.refresh_token) {
        throw new Error('OAuth revocation refresh unavailable');
      }
      const contents = await custody.readAttempt(resultStage, recovered.identity);
      if (contents === undefined) {
        throw new Error('OAuth revocation refresh unavailable');
      }
      const prepared = { configuration, activation };
      await verifyRefreshResult(prepared, claimed, contents, current.refresh_token);
      latest = tokens(contents);
    }
  }
  const materials: Material[] = [];
  if (latest.refresh_token) {
    materials.push({ revokeToken: latest.refresh_token, tokenTypeHint: 'refresh_token' });
  }
  const accessTokens = new Set([latest.access_token, current.access_token]);
  await previousAccessTokens(custody, rows, generation, accessTokens);
  for (const accessToken of accessTokens) {
    if (accessToken !== latest.refresh_token) {
      materials.push({ revokeToken: accessToken, tokenTypeHint: 'access_token' });
    }
  }
  return materials;
}

async function previousAccessTokens(custody: Custody, rows: StoredEvent[],
  generation: ConnectionStage, accessTokens: Set<string>) {
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index]!;
    if (!['connection.created', 'connection.refreshed'].includes(row.event.type)) {
      continue;
    }
    const saved = foldConnection(rows.slice(0, index + 1)).data;
    const activation = saved?.activation;
    if (!saved || activation?.reason !== 'oauth_confirmed' ||
        activation.generation >= generation.generation) {
      continue;
    }
    const stage = { ...generation, generation: activation.generation,
      operationId: activation.operationId, expectedSequence: activation.expectedSequence,
      appendUntil: activation.appendUntil, endpointDigest: activation.endpointDigest };
    const identity = { reference: saved.secretRef.slice('secret:'.length),
      uid: activation.uid, resourceVersion: activation.resourceVersion };
    const recovered = await custody.recover(stage, identity);
    if (recovered.status === 'not_found') {
      continue;
    }
    // Revoke retained access tokens too: rotating refresh tokens need not invalidate them.
    const material = tokens(await custody.readRevocationMaterial(stage, identity));
    accessTokens.add(material.access_token);
  }
}
