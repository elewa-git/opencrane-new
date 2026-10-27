import { isDeepStrictEqual } from 'node:util';
import type { Binding } from '@opencrane/authz';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
import { connectionRefreshedDataSchema, connectionOAuthStartedDataSchema,
  connectionRefreshStartedDataSchema } from '@opencrane/events';
import type { Db } from '@opencrane/projections';
import { envelope, history } from './actor.ts';
import { connectionOperationId, foldConnection } from './bearer-connections.ts';
import type { connectionCustody, ConnectionStage } from './connection-custody.ts';
import { withConnectionStage } from './connection-stage-lock.ts';
import { readActiveMember } from './member-authority.ts';
import { exchangePersonalOAuthRefresh, refreshSaveEvidence } from './oauth-refresh-worker.ts';
import { refreshAccess, refreshInput } from './oauth-refresh.ts';
import { sessionSchema } from './oauth-start.ts';
import type { RemoteNetwork } from './remote-https.ts';

type Custody = ReturnType<typeof connectionCustody>;
type Evidence = NonNullable<ReturnType<typeof refreshSaveEvidence>>;

/** Save verified private material once. Recovery never grants a new provider send. */
export async function savePersonalOAuthRefresh(store: EventStore, binding: Binding,
  rawSession: unknown, custody: Custody, raw: unknown,
  loadConfiguration: (serverId: string) => Promise<unknown>, db: Pick<Db, 'lock'>,
  liveClaim?: unknown, network: RemoteNetwork = {}) {
  try {
    const session = sessionSchema.parse(rawSession);
    const input = refreshInput.parse(raw);
    if (session.siloId !== binding.silo || session.userId !== input.userId) {
      throw new Error('OAuth refresh refused');
    }
    const profile = { ...input, siloId: binding.silo };
    const subject = `connection-${input.userId}-${input.serverId}-${input.profileId}`;
    async function recover() {
      const rows = await history(store, subject, binding.silo, performance.now() + 10_000);
      for (let index = 0; index < rows.length; index++) {
        const row = rows[index]!;
        if (row.event.type !== 'connection.refreshed') {
          continue;
        }
        const before = foldConnection(rows.slice(0, index));
        const after = foldConnection(rows.slice(0, index + 1));
        const saved = after.data;
        const attempt = connectionRefreshStartedDataSchema.safeParse(before.refreshAttempt?.event.data);
        if (!saved || saved.activation.reason !== 'oauth_confirmed' ||
            saved.activation.generation !== input.expectedGeneration + 1 ||
            saved.activation.connectionId !== input.connectionId ||
            !attempt.success || attempt.data.expectedSequence !== input.expectedSequence) {
          continue;
        }
        // Authorise deletion from the saved replacement, even after the member leaves.
        await retirePrevious(custody, rows.slice(0, index), binding.silo);
        // Check current membership before returning the receipt; deletion grants no access.
        await readActiveMember(store, binding, input.userId);
        return { status: 'saved' as const, sequence: row.sequence,
          generation: saved.activation.generation, callsAvailable: false as const };
      }
      return undefined;
    }
    const original = await withConnectionStage(db, profile, recover);
    if (original) {
      return original;
    }
    const verified = await exchangePersonalOAuthRefresh(store, binding, session, custody, input,
      loadConfiguration, db, liveClaim, network);
    const evidence = refreshSaveEvidence(verified);
    async function save() {
      const repeated = await recover();
      if (repeated) {
        return repeated;
      }
      if (!evidence) {
        throw new Error('OAuth refresh evidence unavailable');
      }
      await appendGeneration(store, binding, custody, evidence, loadConfiguration);
      const saved = await recover();
      if (!saved) {
        throw new Error('OAuth refresh save unconfirmed');
      }
      return saved;
    }
    return await withConnectionStage(db, profile, save);
  } catch {
    // Discard private values and dependency causes, including uncertain append and delete replies.
    return { status: 'unknown' as const };
  }
}

async function appendGeneration(store: EventStore, binding: Binding, custody: Custody,
  evidence: Evidence, loadConfiguration: (serverId: string) => Promise<unknown>) {
  const { prepared, generation, resultStage, contents, expiresAt } = evidence;
  const operationId = connectionOperationId(binding.silo, prepared.subject,
    `${resultStage.operationId}-confirm`);
  const stage = { ...generation, generation: generation.generation + 1, operationId,
    expectedSequence: evidence.claimed.sequence, appendUntil: resultStage.appendUntil };
  const current = await refreshAccess(store, binding, prepared, loadConfiguration);
  await current.checkAccess();
  if (Date.now() >= Math.min(expiresAt, stage.appendUntil)) {
    throw new Error('OAuth refresh expired');
  }
  const staged = await custody.stage(stage, contents);
  if (!staged.identity || !['staged', 'recovered'].includes(staged.status)) {
    throw new Error('OAuth refresh generation unavailable');
  }
  const account = { ...prepared.activation.account, expiresAt };
  const activation = { ...prepared.activation, generation: stage.generation, operationId,
    uid: staged.identity.uid, resourceVersion: staged.identity.resourceVersion,
    expectedSequence: stage.expectedSequence, appendUntil: stage.appendUntil, account };
  const payload = { ...prepared.saved, activation,
    secretRef: `secret:${staged.identity.reference}` };
  const data = connectionRefreshedDataSchema.parse(payload);
  const event = { ...envelope(binding.silo, prepared.subject, 'connection.refreshed', data,
    operationId), commandId: prepared.original!.event.commandId, source: 'opencrane-server',
    principal: { kind: 'human' as const, id: stage.userId } };
  // Start the short access deadline after all private staging has finished.
  const checked = await refreshAccess(store, binding, prepared, loadConfiguration);
  async function checkAccess() {
    await checked.checkAccess();
    if (Date.now() >= Math.min(expiresAt, stage.appendUntil)) {
      throw new Error('OAuth refresh expired');
    }
  }
  const command = { event, expectedSequence: checked.categorySequence,
    expectedSubject: 'connection-*', historyChecked: true as const,
    deadline: checked.deadline, checkAccess };
  await store.append(command);
  const rows = await history(store, prepared.subject, binding.silo, performance.now() + 10_000);
  const saved = rows.at(-1);
  if (!saved || !isDeepStrictEqual(saved.event, event) || !foldConnection(rows).data) {
    throw new Error('OAuth refresh save unconfirmed');
  }
}

async function retirePrevious(custody: Custody, rows: StoredEvent[], siloId: string) {
  const saved = foldConnection(rows).data!;
  const activation = saved.activation;
  const stage: ConnectionStage = { siloId, userId: saved.userId, serverId: saved.serverId,
    connectionId: activation.connectionId, profileId: saved.profile, purpose: 'personal',
    generation: activation.generation, endpointDigest: activation.endpointDigest,
    operationId: activation.operationId, expectedSequence: activation.expectedSequence,
    appendUntil: activation.appendUntil };
  const identity = { reference: saved.secretRef.slice('secret:'.length), uid: activation.uid,
    resourceVersion: activation.resourceVersion };
  const removed = await custody.retire(stage, identity);
  if (!['deleted', 'not_found'].includes(removed.status)) {
    throw new Error('OAuth refresh retirement unconfirmed');
  }
  // Remove the earlier reply too: it holds the same old refresh token as the saved generation.
  function originalClaim(row: StoredEvent) {
    return row.sequence === activation.expectedSequence;
  }
  const claim = rows.find(originalClaim)!;
  const resultId = connectionOperationId(siloId, claim.event.subject, `${claim.event.id}-result`);
  let attemptDigest = activation.reason === 'oauth_confirmed'
    ? activation.configurationDigest : undefined;
  if (activation.generation === 1) {
    attemptDigest = connectionOAuthStartedDataSchema.parse(rows[0]!.event.data).attemptDigest;
  }
  const resultStage = { ...stage, generation: 1, operationId: resultId, attemptId: resultId,
    attemptDigest };
  const recovered = await custody.recover(resultStage);
  if (recovered.status === 'not_found') {
    return;
  }
  if (!recovered.identity || recovered.status !== 'recovered') {
    throw new Error('OAuth refresh retirement unavailable');
  }
  const retired = await custody.retire(resultStage, recovered.identity);
  if (retired.status !== 'deleted') {
    throw new Error('OAuth refresh retirement unconfirmed');
  }
}
