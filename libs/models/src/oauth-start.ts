import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { Binding } from '@opencrane/authz';
import { readEventAt, type EventStore, type StoredEvent } from '@opencrane/event-store';
import { connectionOAuthStartedDataSchema, type EventEnvelope } from '@opencrane/events';
import type { Db } from '@opencrane/projections';
import type { connectionCustody } from './connection-custody.ts';
import { envelope, history } from './actor.ts';
import { authorityFence } from './authority.ts';
import { activeMember } from './member-authority.ts';
import { currentMembership } from './ownership.ts';
import { connectionServer } from './connection-server.ts';
import { withConnectionStage } from './connection-stage-lock.ts';
import { oauthConfigurationSchema, oauthConsentUrl, prepareOAuthAttempt } from './oauth-attempt.ts';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/u);
const sessionSchema = z.strictObject({ siloId: id, userId: id,
  sessionDigest: z.string().regex(/^[a-f0-9]{64}$/u), memberRevision: z.int().positive() });
const inputSchema = z.strictObject({ userId: id, serverId: id, connectionId: id, profileId: id,
  changeRef: id, expectedSequence: z.literal(0) });
type Session = z.infer<typeof sessionSchema>;
type Input = z.infer<typeof inputSchema>;
type Custody = Pick<ReturnType<typeof connectionCustody>, 'prepareAttempt' | 'readAttempt'>;
type ConfigurationLoader = (serverId: string) => Promise<unknown>;

/** Accept session and configuration only from trusted server code. No public route calls this. */
export async function startPersonalOAuth(store: EventStore, binding: Binding,
  rawSession: unknown, custody: Custody, raw: unknown, loadConfiguration: ConfigurationLoader,
  db: Pick<Db, 'lock'>) {
  try {
    const session = sessionSchema.parse(rawSession);
    const input = inputSchema.parse(raw);
    if (session.siloId !== binding.silo || session.userId !== input.userId) {
      return { status: 'unknown' as const };
    }
    const profile = { ...input, siloId: session.siloId };
    async function record() {
      return recordStart(store, binding, session, custody, input, loadConfiguration);
    }
    const saved = await withConnectionStage(db, profile, record);
    // Finish private reads and lock release before the final access and expiry checks.
    const contents = await custody.readAttempt(saved.prepared.stage, saved.prepared.identity);
    if (contents === undefined) {
      return { status: 'unknown' as const };
    }
    await saved.checkCurrent(saved.sequence);
    if (Date.now() >= saved.expiresAt) {
      return { status: 'unknown' as const };
    }
    const consentUrl = oauthConsentUrl(saved.configuration, saved.prepared, contents);
    return { status: 'started' as const, consentUrl, changeRef: saved.event.commandId,
      sequence: saved.sequence, appendUntil: saved.prepared.stage.appendUntil };
  } catch {
    // Hide dependency and validation values, including private custody error bodies.
    return { status: 'unknown' as const };
  }
}

async function recordStart(store: EventStore, binding: Binding, session: Session,
  custody: Custody, input: Input, loadConfiguration: ConfigurationLoader) {
  const subject = `connection-${session.userId}-${input.serverId}-${input.profileId}`;
  const rows = await history(store, subject, binding.silo, performance.now() + 10_000);
  const configuration = oauthConfigurationSchema.parse(await loadConfiguration(input.serverId));
  const serverRows = await history(store, `mcp-${input.serverId}`, binding.silo,
    performance.now() + 10_000);
  const server = connectionServer(serverRows, input.connectionId);
  const membership = await currentMembership(store, binding.silo, session.userId,
    undefined, performance.now() + 10_000);
  if (membership.positions.get(`member-${session.userId}`) !== session.memberRevision) {
    throw new Error('OAuth membership changed');
  }
  const controlSubject = `connection-control-${session.userId}-${input.serverId}`;
  const options = { requiredRole: 'member' as const, membership };
  await activeMember(store, binding, session.userId, options);
  if (await store.head(controlSubject, performance.now() + 10_000) !== 0 || rows.length > 1) {
    throw new Error('OAuth start refused');
  }
  const original = rows[0];
  if (original && (original.event.type !== 'connection.oauth_started' ||
      original.event.commandId !== input.changeRef)) {
    throw new Error('OAuth profile already exists');
  }
  const context = { ...session, serverId: input.serverId, connectionId: input.connectionId,
    profileId: input.profileId, changeRef: input.changeRef, expectedSequence: 0 };
  const prepared = await prepareOAuthAttempt(custody, context, configuration, serverRows);
  if (prepared.status !== 'prepared') {
    throw new Error('OAuth custody unavailable');
  }
  const data = connectionOAuthStartedDataSchema.parse({ userId: session.userId,
    serverId: input.serverId, connectionId: input.connectionId, profile: input.profileId,
    attemptId: prepared.stage.operationId, attemptDigest: prepared.stage.attemptDigest,
    stateDigest: prepared.stateDigest, secretRef: `secret:${prepared.identity.reference}`,
    uid: prepared.identity.uid, resourceVersion: prepared.identity.resourceVersion,
    expectedSequence: 0, appendUntil: prepared.stage.appendUntil });
  const event = { ...envelope(binding.silo, subject, 'connection.oauth_started',
    data, data.attemptId), commandId: input.changeRef, source: 'opencrane-server',
    principal: { kind: 'human' as const, id: session.userId } };
  const appendUntil = Math.min(prepared.stage.appendUntil, server.expiresAt);
  async function checkDependencies(sequence: number, deadline: number) {
    const current = oauthConfigurationSchema.parse(await loadConfiguration(input.serverId));
    if (!isDeepStrictEqual(current, configuration)) {
      throw new Error('OAuth configuration changed');
    }
    // Check positions after loading configuration, which may wait for private storage.
    if (await store.head(controlSubject, deadline) !== 0 ||
        await store.head(subject, deadline) !== sequence ||
        await store.head(`mcp-${input.serverId}`, deadline) !== server.sequence) {
      throw new Error('OAuth access changed');
    }
  }
  async function checkCurrent(sequence: number) {
    const subjects = [...membership.positions.keys(), controlSubject, `mcp-${input.serverId}`];
    const fresh = await authorityFence(store, performance.now(), subjects);
    const categorySequence = await store.head('connection-*', fresh.deadline);
    const access = { ...options, fresh };
    await activeMember(store, binding, session.userId, access);
    let checkedPosition = await store.head(undefined, fresh.deadline);
    while (true) {
      await fresh();
      await checkDependencies(sequence, fresh.deadline);
      const currentPosition = await store.head(undefined, fresh.deadline);
      if (currentPosition === checkedPosition) {
        break;
      }
      // Repeat only the small checks when events arrive during a dependency read.
      // Let unrelated activity pass without extending the original two-second deadline.
      checkedPosition = currentPosition;
    }
    if (performance.now() >= fresh.deadline || !Number.isFinite(appendUntil) ||
        Date.now() >= appendUntil) {
      throw new Error('OAuth attempt expired');
    }
    const deadline = Math.min(fresh.deadline, performance.now() + appendUntil - Date.now());
    return { categorySequence, deadline, checkAccess: fresh };
  }
  const checked = await checkCurrent(original?.sequence ?? 0);
  const sequence = await appendStart(store, event, checked, original);
  return { sequence, event, configuration, prepared, checkCurrent, expiresAt: appendUntil };
}

/** Append once. Custody preparation and URL construction belong to the surrounding process. */
async function appendStart(store: EventStore, event: EventEnvelope,
  checked: { categorySequence: number; deadline: number; checkAccess: () => Promise<unknown> },
  original?: StoredEvent) {
  let saved = original;
  if (!saved) {
    // Bind membership and server policy to publication, keeping the original access deadline.
    // Include the persistent admin block in the native conditional append.
    const command = { event, expectedSequence: checked.categorySequence,
      expectedSubject: 'connection-*', historyChecked: true as const, deadline: checked.deadline,
      checkAccess: checked.checkAccess };
    const result = await store.append(command);
    if (result.status !== 'appended') {
      throw new Error('OAuth append unconfirmed');
    }
    saved = await readEventAt(store, event.subject, result.sequence, performance.now() + 10_000);
  }
  if (!saved || !sameStart(saved.event, event)) {
    throw new Error('OAuth append unconfirmed');
  }
  return saved.sequence;
}
function sameStart(saved: EventEnvelope, attempted: EventEnvelope) {
  return saved.id === attempted.id && saved.subject === attempted.subject &&
    saved.silo === attempted.silo && saved.type === attempted.type &&
    saved.source === attempted.source && saved.commandId === attempted.commandId &&
    isDeepStrictEqual(saved.principal, attempted.principal) &&
    isDeepStrictEqual(saved.data, attempted.data);
}
