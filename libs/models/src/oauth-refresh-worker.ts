import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { Binding } from '@opencrane/authz';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
import { connectionOAuthExchangeClaimedDataSchema } from '@opencrane/events';
import type { Db } from '@opencrane/projections';
import { connectionOperationId } from './bearer-connections.ts';
import type { connectionCustody, ConnectionStage } from './connection-custody.ts';
import { withConnectionStage } from './connection-stage-lock.ts';
import { oauthConfigurationDigest } from './oauth-attempt.ts';
import { oauthProviderTransport } from './oauth-exchange.ts';
import { verifyOAuthIdentity } from './oauth-identity.ts';
import { prepareRefresh, refreshAccess, refreshInput,
  takePersonalOAuthRefreshClaim } from './oauth-refresh.ts';
import { sessionSchema } from './oauth-start.ts';
import type { RemoteNetwork } from './remote-https.ts';

type Custody = ReturnType<typeof connectionCustody>;
type Evidence = { prepared: Awaited<ReturnType<typeof prepareRefresh>>;
  claimed: StoredEvent; generation: ConnectionStage; resultStage: ConnectionStage;
  contents: string; expiresAt: number };
const evidence = new WeakMap<object, Evidence>();

export function refreshSaveEvidence(result: object) {
  return evidence.get(result);
}

function verifiedResult(result: Evidence) {
  const verified = { status: 'verified' as const, sequence: result.claimed.sequence,
    callsAvailable: false as const };
  evidence.set(verified, result);
  return verified;
}

/** Send only from the live claim. Restart can recover private bytes, never send again. */
export async function exchangePersonalOAuthRefresh(store: EventStore, binding: Binding,
  rawSession: unknown, custody: Custody, raw: unknown,
  loadConfiguration: (serverId: string) => Promise<unknown>, db: Pick<Db, 'lock'>,
  liveClaim?: unknown, network: RemoteNetwork = {}) {
  const live = takePersonalOAuthRefreshClaim(liveClaim);
  try {
    const session = sessionSchema.parse(rawSession);
    const input = refreshInput.parse(raw);
    if (session.siloId !== binding.silo || session.userId !== input.userId) {
      throw new Error('OAuth refresh refused');
    }
    const profile = { ...input, siloId: binding.silo };
    async function exchange() {
      const prepared = await prepareRefresh(store, binding, session, input, loadConfiguration);
      const claimed = prepared.state.refreshClaim;
      if (!claimed) {
        throw new Error('OAuth refresh claim unavailable');
      }
      const claim = connectionOAuthExchangeClaimedDataSchema.parse(claimed.event.data);
      const activation = prepared.activation;
      const generation: ConnectionStage = { siloId: binding.silo, userId: input.userId,
        serverId: input.serverId, connectionId: input.connectionId, profileId: input.profileId,
        purpose: 'personal',
        generation: activation.generation, endpointDigest: activation.endpointDigest,
        operationId: activation.operationId, expectedSequence: activation.expectedSequence,
        appendUntil: activation.appendUntil };
      const identity = { reference: prepared.saved.secretRef.slice('secret:'.length),
        uid: activation.uid, resourceVersion: activation.resourceVersion };
      const refreshToken = await custody.readRefreshMaterial(generation, identity);
      if (!refreshToken) {
        throw new Error('OAuth refresh material unavailable');
      }
      const operationId = connectionOperationId(binding.silo, prepared.subject,
        `${claimed.event.id}-result`);
      const resultStage = { ...generation, generation: 1, operationId, attemptId: operationId,
        attemptDigest: oauthConfigurationDigest(prepared.configuration),
        expectedSequence: claimed.sequence, appendUntil: claim.appendUntil };
      async function checkCurrent() {
        const checked = await refreshAccess(store, binding, prepared, loadConfiguration);
        await checked.checkAccess();
        if (Date.now() >= claim.appendUntil) {
          throw new Error('OAuth refresh expired');
        }
      }
      let result = await custody.recover(resultStage);
      await checkCurrent();
      if (result.status !== 'recovered' || !result.identity) {
        if (!live || live.claimId !== claimed.event.id || live.sequence !== claimed.sequence ||
            live.workerId !== claim.workerId || !await custody.claimSend(resultStage)) {
          throw new Error('OAuth refresh send unavailable');
        }
        await checkCurrent();
        const configuration = { tokenEndpoint: prepared.configuration.tokenEndpoint,
          clientId: prepared.configuration.clientId, redirectUri: prepared.configuration.redirectUri };
        const send = oauthProviderTransport(configuration, network);
        const material = { refreshToken };
        const reply = await send(material, new AbortController().signal, checkCurrent);
        // Retain received bytes even when access changes while the provider is replying.
        result = await custody.stage(resultStage, reply.toString('utf8'));
      }
      if (!result.identity || !['staged', 'recovered'].includes(result.status)) {
        throw new Error('OAuth refresh result unavailable');
      }
      const contents = await custody.readAttempt(resultStage, result.identity);
      if (contents === undefined) {
        throw new Error('OAuth refresh result unavailable');
      }
      const expiresAt = await verifyResult(prepared, claimed, contents, refreshToken);
      return { prepared, claimed, generation, resultStage, contents, checkCurrent, expiresAt };
    }
    const result = await withConnectionStage(db, profile, exchange);
    await result.checkCurrent();
    if (Date.now() >= result.expiresAt) {
      throw new Error('OAuth refresh identity expired');
    }
    return verifiedResult(result);
  } catch {
    // Discard private provider and custody failures, including attached causes.
    return { status: 'unknown' as const };
  }
}

async function verifyResult(prepared: Awaited<ReturnType<typeof prepareRefresh>>,
  claimed: StoredEvent, contents: string, previousRefresh: string) {
  const verified = await verifyOAuthIdentity(prepared.configuration, contents);
  const account = prepared.activation.account;
  if (!verified || verified.identity.issuer !== account.issuer ||
      verified.identity.subject !== account.subject) {
    throw new Error('OAuth refresh identity unavailable');
  }
  const schema = z.object({ refresh_token: z.string().regex(/^[\x21-\x7e]{1,4096}$/u),
    expires_in: z.int().positive().max(86_400), scope: z.string().max(4096) });
  const reply = schema.parse(JSON.parse(contents));
  const scopes = reply.scope === '' ? [] : reply.scope.split(' ');
  if (reply.refresh_token === previousRefresh || !isDeepStrictEqual(scopes, account.scopes)) {
    throw new Error('OAuth refresh replacement refused');
  }
  // Count from the saved claim so recovery cannot extend the provider's lifetime.
  const expiresAt = Date.parse(claimed.event.time) + reply.expires_in * 1000;
  return Math.min(expiresAt, verified.expiresAt);
}
