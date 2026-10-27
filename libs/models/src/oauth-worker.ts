import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { Binding } from '@opencrane/authz';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
import { connectionOAuthExchangeClaimedDataSchema } from '@opencrane/events';
import type { Db } from '@opencrane/projections';
import { history } from './actor.ts';
import { connectionOperationId } from './bearer-connections.ts';
import type { connectionCustody } from './connection-custody.ts';
import { withConnectionStage } from './connection-stage-lock.ts';
import { oauthConsentUrl } from './oauth-attempt.ts';
import { takePersonalOAuthClaim } from './oauth-callback.ts';
import { oauthProviderTransport } from './oauth-exchange.ts';
import { checkPersonalOAuthStart, inputSchema, sessionSchema } from './oauth-start.ts';
import type { RemoteNetwork } from './remote-https.ts';

type Custody = ReturnType<typeof connectionCustody>;
type Saved = Awaited<ReturnType<typeof checkPersonalOAuthStart>>;

/** Run only from trusted live orchestration. Replay never calls this worker. */
export async function exchangePersonalOAuth(store: EventStore, binding: Binding,
  rawSession: unknown, custody: Custody, raw: unknown,
  loadConfiguration: (serverId: string) => Promise<unknown>, db: Pick<Db, 'lock'>,
  liveClaim?: unknown, network: RemoteNetwork = {}) {
  // Consume before waiting, so neither a retry nor a copied event can inherit this permission.
  const live = takePersonalOAuthClaim(liveClaim);
  try {
    const session = sessionSchema.parse(rawSession);
    const input = inputSchema.parse(raw);
    if (session.siloId !== binding.silo || session.userId !== input.userId) {
      throw new Error('OAuth exchange refused');
    }
    const profile = { ...input, siloId: session.siloId };
    const subject = `connection-${session.userId}-${input.serverId}-${input.profileId}`;
    async function exchange() {
      const rows = await history(store, subject, binding.silo, performance.now() + 10_000);
      const claimed = rows[1];
      if (rows.length !== 2 || claimed?.event.type !== 'connection.oauth_exchange_claimed') {
        throw new Error('OAuth exchange refused');
      }
      const sequence = claimed.sequence;
      const saved = await checkPersonalOAuthStart(store, binding, session, custody, input,
        loadConfiguration, claimed);
      const codeStage = checkedClaim(saved, claimed);
      const resultId = connectionOperationId(binding.silo, subject, `${codeStage.operationId}-result`);
      const resultStage = { ...codeStage, operationId: resultId, attemptId: resultId,
        expectedSequence: claimed.sequence };
      const material = await readMaterial(custody, saved, claimed, codeStage);
      const recovered = await custody.recover(resultStage);
      if (recovered.status === 'recovered' && recovered.identity) {
        return { saved, claimed, resultStage, identity: recovered.identity };
      }
      const data = connectionOAuthExchangeClaimedDataSchema.parse(claimed.event.data);
      if (!live || live.claimId !== claimed.event.id || live.sequence !== sequence ||
          live.workerId !== data.workerId) {
        throw new Error('OAuth exchange refused');
      }
      const configuration = { tokenEndpoint: saved.configuration.tokenEndpoint,
        clientId: saved.configuration.clientId, redirectUri: saved.configuration.redirectUri };
      const send = oauthProviderTransport(configuration, network);
      await saved.checkCurrent(sequence);
      if (!await custody.claimSend(codeStage)) {
        throw new Error('OAuth send already attempted');
      }
      // Recheck after the durable marker's flush, before any provider bytes can leave.
      await saved.checkCurrent(sequence);
      async function checkBeforeSend() {
        await saved.checkCurrent(sequence);
      }
      const reply = await send(material, new AbortController().signal, checkBeforeSend);
      await saved.checkCurrent(sequence);
      const staged = await custody.stage(resultStage, reply.toString('utf8'));
      if (!staged.identity || !['staged', 'recovered'].includes(staged.status)) {
        throw new Error('OAuth result unavailable');
      }
      return { saved, claimed, resultStage, identity: staged.identity };
    }
    const result = await withConnectionStage(db, profile, exchange);
    const contents = await custody.readAttempt(result.resultStage, result.identity);
    if (contents === undefined) {
      throw new Error('OAuth result unavailable');
    }
    await result.saved.checkCurrent(result.claimed.sequence);
    return { status: 'unconfirmed' as const, changeRef: result.resultStage.operationId,
      sequence: result.claimed.sequence, reference: result.identity.reference };
  } catch {
    // Keep provider replies, custody failures and their causes out of returned status.
    return { status: 'unknown' as const };
  }
}

function checkedClaim(saved: Saved, claimed: StoredEvent) {
  const original = saved.prepared.stage;
  const operationId = connectionOperationId(original.siloId, saved.event.subject,
    `${original.operationId}-exchange`);
  const stage = { ...original, operationId, attemptId: operationId,
    expectedSequence: saved.original!.sequence };
  const event = claimed.event;
  const data = connectionOAuthExchangeClaimedDataSchema.parse(event.data);
  const expected = { ...data, userId: original.userId, serverId: original.serverId,
    connectionId: original.connectionId, profile: original.profileId,
    attemptId: original.operationId, purpose: 'consent',
    expectedSequence: saved.original!.sequence, appendUntil: original.appendUntil };
  if (event.id !== operationId || event.commandId !== operationId ||
      event.subject !== saved.event.subject || event.silo !== original.siloId ||
      event.source !== 'opencrane-server' || !isDeepStrictEqual(event.principal, saved.event.principal) ||
      !isDeepStrictEqual(data, expected)) {
    throw new Error('OAuth claim changed');
  }
  return stage;
}

async function readMaterial(custody: Custody, saved: Saved, claimed: StoredEvent,
  codeStage: ReturnType<typeof checkedClaim>) {
  const data = connectionOAuthExchangeClaimedDataSchema.parse(claimed.event.data);
  const identity = { reference: data.secretRef.slice('secret:'.length), uid: data.uid,
    resourceVersion: data.resourceVersion };
  const codeContents = await custody.readAttempt(codeStage, identity);
  const attemptContents = await custody.readAttempt(saved.prepared.stage, saved.prepared.identity);
  if (codeContents === undefined || attemptContents === undefined) {
    throw new Error('OAuth material unavailable');
  }
  oauthConsentUrl(saved.configuration, saved.prepared, attemptContents);
  const code = z.strictObject({ code: z.string() }).parse(JSON.parse(codeContents));
  const attempt = z.object({ verifier: z.string() }).parse(JSON.parse(attemptContents));
  return { code: code.code, verifier: attempt.verifier };
}
