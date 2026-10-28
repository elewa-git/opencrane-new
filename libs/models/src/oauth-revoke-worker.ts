import type { EventStore } from '@opencrane/event-store';
import type { Db } from '@opencrane/projections';
import { foldConnection } from './bearer-connections.ts';
import type { connectionCustody, ConnectionStage } from './connection-custody.ts';
import { withConnectionStage } from './connection-stage-lock.ts';
import { oauthConfigurationDigest, oauthConfigurationSchema } from './oauth-attempt.ts';
import { oauthProviderTransport } from './oauth-exchange.ts';
import { refreshInput } from './oauth-refresh.ts';
import { prepareRevoke } from './oauth-revoke.ts';
import { resolveRevocationTokens } from './oauth-revoke-material.ts';
import type { RemoteNetwork } from './remote-https.ts';

type Custody = ReturnType<typeof connectionCustody>;

/** Run privately after a saved revoke. This worker grants no member access or receipt. */
export async function finishPersonalOAuthRevoke(store: EventStore, siloId: string,
  custody: Custody, raw: unknown, loadConfiguration: (serverId: string) => Promise<unknown>,
  db: Pick<Db, 'lock'>, network: RemoteNetwork = {}) {
  try {
    const input = refreshInput.parse(raw);
    const profile = { ...input, siloId };
    async function finish() {
      const subject = `connection-${input.userId}-${input.serverId}-${input.profileId}`;
      const prepared = await prepareRevoke(store, siloId, subject, input);
      const saved = foldConnection(prepared?.preceding ?? []).data;
      const activation = saved?.activation;
      if (!prepared?.original || !saved || activation?.reason !== 'oauth_confirmed') {
        return { status: 'unknown' as const };
      }
      const generation: ConnectionStage = { siloId, userId: input.userId,
        serverId: input.serverId, connectionId: input.connectionId, profileId: input.profileId,
        purpose: 'personal', generation: activation.generation,
        endpointDigest: activation.endpointDigest, operationId: activation.operationId,
        expectedSequence: activation.expectedSequence, appendUntil: activation.appendUntil };
      const preceding = prepared.preceding;
      const configurationDigest = activation.configurationDigest;
      async function send() {
        const rawConfiguration = await loadConfiguration(input.serverId);
        const configuration = oauthConfigurationSchema.parse(rawConfiguration);
        if (!configuration.revocationEndpoint ||
            oauthConfigurationDigest(configuration) !== configurationDigest) {
          throw new Error('OAuth revoke configuration unavailable');
        }
        const materials = await resolveRevocationTokens(custody, preceding,
          generation, configuration);
        const settings = { revocationEndpoint: configuration.revocationEndpoint,
          clientId: configuration.clientId };
        const transport = oauthProviderTransport(settings, network);
        for (const material of materials) {
          await transport(material, new AbortController().signal);
        }
      }
      let confirmed = false;
      try {
        confirmed = await custody.revokeOnce(prepared.original.event.id, send);
      } catch {
        // Retire local copies even when the provider's outcome cannot be recovered.
      }
      const retired = await retireCopies(custody, generation, prepared.original.sequence);
      if (!confirmed || !retired) {
        return { status: 'unknown' as const };
      }
      return { status: 'completed' as const };
    }
    return await withConnectionStage(db, profile, finish);
  } catch {
    // Discard private dependency errors and their causes.
    return { status: 'unknown' as const };
  }
}

async function retireCopies(custody: Custody, generation: ConnectionStage, revokedAt: number) {
  let continuation: string | undefined;
  let complete = true;
  do {
    const page = await custody.candidates(continuation);
    if (page.status !== 'listed') {
      return false;
    }
    complete = complete && page.complete;
    for (const stage of page.stages) {
      if (stage.purpose !== 'personal' || stage.siloId !== generation.siloId ||
          stage.userId !== generation.userId ||
          stage.serverId !== generation.serverId || stage.profileId !== generation.profileId ||
          stage.expectedSequence >= revokedAt) {
        continue;
      }
      const recovered = await custody.recover(stage);
      if (recovered.status === 'not_found') {
        continue;
      }
      if (!recovered.identity || recovered.status !== 'recovered') {
        complete = false;
        continue;
      }
      const retired = await custody.retire(stage, recovered.identity);
      complete = complete && retired.status === 'deleted';
    }
    continuation = page.continuation;
  } while (continuation);
  return complete;
}
