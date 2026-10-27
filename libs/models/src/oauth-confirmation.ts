import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { Binding } from '@opencrane/authz';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
import { connectionCreatedDataSchema } from '@opencrane/events';
import type { Db } from '@opencrane/projections';
import { envelope, history } from './actor.ts';
import { connectionOperationId, foldConnection } from './bearer-connections.ts';
import type { connectionCustody, ConnectionStage } from './connection-custody.ts';
import { withConnectionStage } from './connection-stage-lock.ts';
import { readActiveMember } from './member-authority.ts';
import { verifyOAuthIdentity } from './oauth-identity.ts';
import { oauthConfigurationDigest } from './oauth-attempt.ts';
import { inputSchema, sessionSchema } from './oauth-start.ts';
import { personalOAuthEvidence } from './oauth-worker.ts';

type Custody = ReturnType<typeof connectionCustody>;
type Evidence = NonNullable<ReturnType<typeof personalOAuthEvidence>>;
const replySchema = z.object({ expires_in: z.int().positive(), scope: z.string().max(4096) });

/** Confirm an internal verified result explicitly. No route or replay handler calls this. */
export async function confirmPersonalOAuth(store: EventStore, binding: Binding,
  rawSession: unknown, custody: Custody, raw: unknown, evidence: unknown,
  confirmed: boolean, db: Pick<Db, 'lock'>) {
  try {
    const session = sessionSchema.parse(rawSession);
    const input = inputSchema.parse(raw);
    if (session.siloId !== binding.silo || session.userId !== input.userId) {
      throw new Error('OAuth confirmation refused');
    }
    const profile = { ...input, siloId: session.siloId };
    const subject = `connection-${session.userId}-${input.serverId}-${input.profileId}`;
    async function confirm() {
      const rows = await history(store, subject, binding.silo, performance.now() + 10_000);
      // Recover a receipt before touching expired consent. A receipt grants no credential use.
      const original = savedReceipt(rows, input);
      if (original) {
        await readActiveMember(store, binding, session.userId);
        return original;
      }
      const checked = personalOAuthEvidence(evidence);
      if (confirmed !== true || !checked || !isDeepStrictEqual(checked.session, session) ||
          !isDeepStrictEqual(checked.input, input) || rows.length !== 2 ||
          !isDeepStrictEqual(rows[0], checked.saved.original) ||
          !isDeepStrictEqual(rows[1], checked.claimed)) {
        throw new Error('OAuth confirmation refused');
      }
      const prepared = await stageGeneration(custody, checked);
      return appendGeneration(store, checked, prepared);
    }
    return await withConnectionStage(db, profile, confirm);
  } catch {
    // Discard private custody and provider errors, including attached causes.
    return { status: 'unknown' as const };
  }
}

function savedReceipt(rows: StoredEvent[], input: z.infer<typeof inputSchema>) {
  const saved = foldConnection(rows).data;
  if (rows.length === 3 && saved?.activation.reason === 'oauth_confirmed' &&
      saved.userId === input.userId && saved.serverId === input.serverId &&
      saved.profile === input.profileId && saved.activation.connectionId === input.connectionId &&
      rows[0]?.event.commandId === input.changeRef) {
    return receipt(rows[2]!);
  }
  return undefined;
}

async function stageGeneration(custody: Custody, evidence: Evidence) {
  const { saved, claimed, resultStage, identity } = evidence;
  const attempt = saved.prepared;
  const attemptContents = await custody.readAttempt(attempt.stage, attempt.identity);
  const contents = await custody.readAttempt(resultStage, identity);
  if (contents === undefined || attemptContents === undefined) {
    throw new Error('OAuth evidence unavailable');
  }
  const verified = await verifyOAuthIdentity(saved.configuration, contents, attemptContents);
  if (!verified) {
    throw new Error('OAuth identity unavailable');
  }
  const reply = replySchema.parse(JSON.parse(contents));
  // Count from the earlier claim, so recovery can never extend the provider's lifetime.
  const expiresAt = Date.parse(claimed.event.time) + reply.expires_in * 1000;
  const scopes = reply.scope === '' ? [] : reply.scope.split(' ');
  const account = { ...verified.identity, scopes, expiresAt };
  await saved.checkCurrent(claimed.sequence);
  const operationId = connectionOperationId(resultStage.siloId, claimed.event.subject,
    `${resultStage.operationId}-confirm`);
  const stage: ConnectionStage = { siloId: resultStage.siloId, userId: resultStage.userId,
    serverId: resultStage.serverId, connectionId: resultStage.connectionId,
    profileId: resultStage.profileId, purpose: 'personal', generation: 1,
    endpointDigest: resultStage.endpointDigest, operationId, expectedSequence: claimed.sequence,
    appendUntil: resultStage.appendUntil };
  const identityUntil = Math.min(verified.expiresAt, expiresAt);
  if (!Number.isSafeInteger(expiresAt) || Date.now() >= identityUntil) {
    throw new Error('OAuth evidence expired');
  }
  const staged = await custody.stage(stage, contents);
  if (!staged.identity || !['staged', 'recovered'].includes(staged.status)) {
    throw new Error('OAuth generation unavailable');
  }
  const payload = { userId: stage.userId,
    serverId: stage.serverId, profile: stage.profileId,
    secretRef: `secret:${staged.identity.reference}`, activation: {
      connectionId: stage.connectionId, ownerKind: 'personal', purpose: 'personal', generation: 1,
      uid: staged.identity.uid, resourceVersion: staged.identity.resourceVersion,
      endpointDigest: stage.endpointDigest, operationId, changedBy: stage.userId,
      expectedSequence: stage.expectedSequence, appendUntil: stage.appendUntil,
      reason: 'oauth_confirmed', account,
      configurationDigest: oauthConfigurationDigest(saved.configuration),
    } };
  const data = connectionCreatedDataSchema.parse(payload);
  const event = { ...envelope(stage.siloId, claimed.event.subject, 'connection.created',
    data, operationId), commandId: saved.event.commandId, source: 'opencrane-server',
    principal: { kind: 'human' as const, id: stage.userId } };
  return { event, identityUntil };
}

async function appendGeneration(store: EventStore, evidence: Evidence,
  prepared: Awaited<ReturnType<typeof stageGeneration>>) {
  const checked = await evidence.saved.checkCurrent(evidence.claimed.sequence);
  async function checkAccess() {
    // Recheck settings at publication as well as membership, without extending this deadline.
    await evidence.saved.checkCurrent(evidence.claimed.sequence);
    if (performance.now() >= checked.deadline || Date.now() >= prepared.identityUntil) {
      throw new Error('OAuth confirmation expired');
    }
  }
  const command = { event: prepared.event, expectedSequence: checked.categorySequence,
    expectedSubject: 'connection-*', historyChecked: true as const,
    deadline: checked.deadline, checkAccess };
  const result = await store.append(command);
  if (result.status !== 'appended') {
    throw new Error('OAuth activation unconfirmed');
  }
  const rows = await history(store, prepared.event.subject, prepared.event.silo,
    performance.now() + 10_000);
  const saved = rows[2];
  if (rows.length !== 3 || !saved || saved.sequence !== result.sequence ||
      !isDeepStrictEqual(saved.event, prepared.event) || !foldConnection(rows).data) {
    throw new Error('OAuth activation unconfirmed');
  }
  return receipt(saved);
}

function receipt(row: StoredEvent) {
  return { status: 'saved' as const, changeRef: row.event.commandId, sequence: row.sequence,
    generation: 1, callsAvailable: false as const };
}
