import { isDeepStrictEqual } from 'node:util';
import type { EventStore } from '@opencrane/event-store';
import type { Db } from '@opencrane/projections';
import { decisionRecordedDataSchema, toolCredentialReleaseSchema } from '@opencrane/events';
import { history } from './actor.ts';
import type { connectionCustody, ConnectionStage } from './connection-custody.ts';
import { withConnectionStage } from './connection-stage-lock.ts';
import { confirmCredentialRelease, confirmPreparedCredentialRelease, credentialReleaseEvidence,
  type PreparedCredentialRelease } from './credential-release.ts';
import { MemberAccessRefused } from './member-authority.ts';
import type { OAuthConfigurationLoader } from './oauth-selection.ts';
import { requireTrackedPosition } from './mcp-position.ts';

const contextSchema = toolCredentialReleaseSchema.pick({ requestId: true, permitId: true,
  userId: true, assistantId: true, computerId: true, computerGeneration: true,
  conversationId: true, turnId: true, threadId: true, serverId: true, toolName: true,
  argumentsDigest: true, purpose: true });
const savedContextSchema = contextSchema.strip();
export function credentialBrokerContext(release: unknown) {
  return savedContextSchema.parse(release);
}

type PersonalPreparedRelease = PreparedCredentialRelease & {
  release: ReturnType<typeof toolCredentialReleaseSchema.parse>;
};
type Access = { deadline: number; checkAccess: () => Promise<void> };
type Custody = Pick<ReturnType<typeof connectionCustody>, 'readAccessMaterial'>;
function refuse(): never {
  throw new Error('Release unavailable');
}

function personalEvidence(evidence: Awaited<ReturnType<typeof credentialReleaseEvidence>>) {
  if ('company' in evidence) {
    refuse();
  }
  return evidence;
}

async function binding(store: EventStore, silo: string,
  context: ReturnType<typeof contextSchema.safeParse>) {
  if (!context.success) {
    refuse();
  }
  const rows = await history(store, `decision-${context.data.requestId}`, silo,
    performance.now() + 10_000);
  const release = decisionRecordedDataSchema.parse(rows[0]?.event.data).release;
  if (!release || release.ownerKind !== 'personal' ||
      release.ownerId !== context.data.userId) {
    refuse();
  }
  const expected = credentialBrokerContext(release);
  if (!isDeepStrictEqual(context.data, expected)) {
    refuse();
  }
  return release;
}

/** Keep one request private. The caller supplies authenticated context and live dispatch checks. */
export function credentialBroker(store: EventStore, db: Pick<Db, 'lock'>, custody: Custody,
  silo: string, decisionId: string, raw: unknown, loadConfiguration: OAuthConfigurationLoader,
  prepareAccess: () => Promise<Access>, sendAccess: (material: string) => Promise<void>) {
  let used = false;
  let prepared: PersonalPreparedRelease | undefined;
  // Copy before any wait, so caller mutation cannot replace the authenticated request.
  const context = contextSchema.safeParse(raw);
  async function execute(recover: boolean) {
    let permission: Promise<Access> | undefined;
    let refusal: MemberAccessRefused | undefined;
    async function decide() {
      try {
        const access = await prepareAccess();
        async function checkAccess() {
          try {
            await access.checkAccess();
          } catch (error) {
            if (error instanceof MemberAccessRefused) {
              refusal = error;
            }
            throw error;
          }
        }
        return { deadline: access.deadline, checkAccess };
      } catch (error) {
        if (error instanceof MemberAccessRefused) {
          refusal = error;
        }
        throw error;
      }
    }
    function prepare() {
      permission ??= decide();
      return permission;
    }
    try {
      const release = prepared?.release ?? await binding(store, silo, context);
      const profile = { siloId: silo, userId: release.userId,
        serverId: release.serverId, profileId: release.profileId };
      async function work(locked: Db) {
        if (recover) {
          return confirmCredentialRelease(store, silo, release.userId, decisionId, release,
            prepare, 'recover', loadConfiguration);
        }
        const request = { silo, decisionId, release, loadConfiguration,
          prepareAccess: prepare, sendAccess, prepared };
        return sendCurrent(store, locked, custody, request);
      }
      // Keep retirement behind the exact read and the final invocation of the callback.
      return await withConnectionStage(db, profile, work);
    } catch {
      // Hold validation, history and lock failures behind the same permission decision.
      try {
        await prepare();
      } catch {
        // Keep the typed refusal below; hide all other dependency details.
      }
      if (refusal) {
        throw refusal;
      }
      return refuse();
    }
  }
  async function prepare() {
    if (used) refuse();
    const release = await binding(store, silo, context);
    const evidence = await credentialReleaseEvidence(store, silo, decisionId, release,
      loadConfiguration);
    prepared = { release, evidence };
  }
  async function send() {
    if (used) {
      refuse();
    }
    used = true;
    await execute(false);
  }
  async function recover() {
    // Recover only evidence. Neither this result nor a restarted instance permits another send.
    return execute(true);
  }
  return { prepare, send, recover };
}

export interface CredentialSendRequest {
  silo: string;
  decisionId: string;
  release: ReturnType<typeof toolCredentialReleaseSchema.parse>;
  loadConfiguration: OAuthConfigurationLoader;
  prepareAccess: () => Promise<Access>;
  sendAccess: (material: string) => Promise<void>;
  prepared?: PreparedCredentialRelease | undefined;
}

async function sendCurrent(store: EventStore, locked: Db, custody: Custody,
  request: CredentialSendRequest) {
  const { silo, release, prepareAccess, sendAccess } = request;
  const profile = { siloId: silo, userId: release.userId,
    serverId: release.serverId, profileId: release.profileId };
  const evidence = await readSendEvidence(store, request);
  const saved = evidence.profile;
  const activation = saved.activation;
  const stage: ConnectionStage = { ...profile, connectionId: activation.connectionId,
    purpose: 'personal', generation: activation.generation,
    endpointDigest: activation.endpointDigest, operationId: activation.operationId,
    expectedSequence: activation.expectedSequence, appendUntil: activation.appendUntil };
  const identity = { reference: saved.secretRef.slice('secret:'.length),
    uid: activation.uid, resourceVersion: activation.resourceVersion };
  const until = performance.now() + Math.min(30_000, release.expiresAt - Date.now());
  let material: string | undefined;
  function discard() {
    material = undefined;
  }
  const timer = setTimeout(discard, Math.max(0, until - performance.now()));
  try {
    let access: Access | undefined;
    async function prepare() {
      const current = await prepareAccess();
      const deadline = Math.min(current.deadline, performance.now() + 2000, until);
      access = { ...current, deadline };
      return access;
    }
    const prepared = { release, evidence };
    const accessCheck = await prepare();
    const receipt = await confirmPreparedCredentialRelease(store, silo, prepared,
      accessCheck, 'claim');
    evidence.positions.set(`credential-${release.requestId}`, receipt.sequence);
    if (!access) {
      refuse();
    }
    // Save the release audit before reading any material, even if custody later fails.
    const format = activation.reason === 'oauth_confirmed' ? 'oauth' : 'bearer';
    material = await custody.readAccessMaterial(stage, identity, format);
    if (material === undefined || performance.now() >= until) {
      refuse();
    }
    await access.checkAccess();
    if (!await evidence.oauth.configurationCurrent()) {
      refuse();
    }
    for (const [subject, position] of evidence.positions) {
      await requireTrackedPosition(store, silo, subject, position, release.serverId,
        access.deadline);
    }
    // Check the session that owns the lock, not a different pooled connection.
    const queryOptions = { deadline: access.deadline };
    await locked.query('SELECT 1', [], queryOptions);
    if (material === undefined || performance.now() >= access.deadline ||
        Date.now() >= Math.min(release.expiresAt, evidence.expiresAt)) {
      refuse();
    }
    // Burn before invoking the callback. Drop our reference before waiting for its result.
    try {
      const pending = sendAccess(material);
      discard();
      await pending;
    } catch {
      // Hide transport errors even if the callback happens to use an access-error type.
      refuse();
    }
    return undefined;
  } finally {
    clearTimeout(timer);
    discard();
  }
}

async function readSendEvidence(store: EventStore, request: CredentialSendRequest) {
  const { silo, decisionId, release, loadConfiguration } = request;
  const checked = request.prepared?.evidence ?? await credentialReleaseEvidence(store,
    silo, decisionId, release, loadConfiguration);
  const evidence = personalEvidence(checked);
  if (!evidence.oauth || evidence.receipts.length !== 0 ||
      !Number.isFinite(evidence.expiresAt) || Date.now() >= evidence.expiresAt) {
    refuse();
  }
  return { ...evidence, oauth: evidence.oauth };
}
