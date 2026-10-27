import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Binding } from '@opencrane/authz';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
import { connectionRefreshStartedDataSchema,
  connectionOAuthExchangeClaimedDataSchema, type EventEnvelope } from '@opencrane/events';
import type { Db } from '@opencrane/projections';
import { envelope, history } from './actor.ts';
import { authorityFence } from './authority.ts';
import { connectionOperationId, foldConnection } from './bearer-connections.ts';
import type { connectionCustody, ConnectionStage } from './connection-custody.ts';
import { connectionServer } from './connection-server.ts';
import { withConnectionStage } from './connection-stage-lock.ts';
import { activeMember } from './member-authority.ts';
import { currentMembership } from './ownership.ts';
import { oauthConfigurationDigest, oauthConfigurationSchema } from './oauth-attempt.ts';
import { inputSchema, sessionSchema } from './oauth-start.ts';
import { toolPolicyFromRows } from './tool-policy.ts';

const refreshInput = inputSchema.extend({ expectedSequence: z.int().positive(),
  expectedGeneration: z.int().positive() });
type Custody = Pick<ReturnType<typeof connectionCustody>, 'hasRefreshMaterial'>;
type LiveClaim = { status: 'claimed'; claimId: string; sequence: number; workerId: string };
const liveClaims = new WeakMap<object, LiveClaim>();

/** Consume only the original live claim. A copied receipt or replay grants no send. */
export function takePersonalOAuthRefreshClaim(raw: unknown): LiveClaim | undefined {
  if (typeof raw !== 'object' || raw === null) {
    return undefined;
  }
  const claim = liveClaims.get(raw);
  liveClaims.delete(raw);
  return claim;
}

/** Claim only a saved refresh attempt. Transport and staging are separate work. */
export async function claimPersonalOAuthRefresh(store: EventStore, binding: Binding,
  rawSession: unknown, custody: Custody, raw: unknown,
  loadConfiguration: Loader, db: Pick<Db, 'lock'>) {
  try {
    const session = sessionSchema.parse(rawSession);
    const input = refreshInput.parse(raw);
    if (session.siloId !== binding.silo || session.userId !== input.userId) {
      throw new Error('OAuth refresh refused');
    }
    const profile = { ...input, siloId: binding.silo };
    const workerId = randomUUID();
    async function claim() {
      const prepared = await prepareRefresh(store, binding, session, input, loadConfiguration);
      if (!prepared.original || prepared.state.refreshClaim) {
        throw new Error('OAuth refresh claim unavailable');
      }
      // Fix expiry before private reads. Retrying cannot extend a saved claim's lifetime.
      const now = Date.now();
      const appendUntil = now + 60_000;
      await checkPrivateRefresh(custody, prepared, binding.silo, true);
      const checked = await refreshAccess(store, binding, prepared, loadConfiguration);
      const event = refreshClaimEvent(binding.silo, prepared, workerId, now, appendUntil);
      async function checkAccess() {
        await checked.checkAccess();
        if (Date.now() >= appendUntil) {
          throw new Error('OAuth refresh claim expired');
        }
      }
      await checkAccess();
      const sequence = await appendRefreshClaim(store, event, checked, checkAccess);
      return { prepared, sequence, event, appendUntil };
    }
    const result = await withConnectionStage(db, profile, claim);
    // Finish lock release and exact private reads before granting this worker permission.
    await checkPrivateRefresh(custody, result.prepared, binding.silo, true);
    const checked = await refreshAccess(store, binding, result.prepared,
      loadConfiguration, result.sequence);
    await checked.checkAccess();
    if (Date.now() >= result.appendUntil) {
      throw new Error('OAuth refresh claim expired');
    }
    const live = Object.freeze({ status: 'claimed' as const, claimId: result.event.id,
      sequence: result.sequence, workerId });
    liveClaims.set(live, live);
    return live;
  } catch {
    // Discard private errors and causes. An uncertain claim never grants permission.
    return { status: 'unknown' as const };
  }
}

function refreshClaimEvent(siloId: string, prepared: Prepared, workerId: string,
  now: number, appendUntil: number) {
  const { input, subject, activation, saved, original } = prepared;
  const attempt = connectionRefreshStartedDataSchema.parse(original!.event.data);
  const claimId = connectionOperationId(siloId, subject, `${attempt.attemptId}-exchange`);
  const data = connectionOAuthExchangeClaimedDataSchema.parse({ userId: input.userId,
    serverId: input.serverId, connectionId: input.connectionId, profile: input.profileId,
    attemptId: attempt.attemptId, workerId, purpose: 'refresh', secretRef: saved.secretRef,
    uid: activation.uid, resourceVersion: activation.resourceVersion,
    expectedSequence: original!.sequence, appendUntil });
  return { ...envelope(siloId, subject, 'connection.oauth_exchange_claimed', data, claimId,
    new Date(now)), source: 'opencrane-server',
    principal: { kind: 'human' as const, id: input.userId } };
}

/** Append once, then confirm this invocation's exact worker identity from saved history. */
async function appendRefreshClaim(store: EventStore, event: EventEnvelope,
  checked: Awaited<ReturnType<typeof refreshAccess>>, checkAccess: () => Promise<void>) {
  const command = { event, expectedSequence: checked.categorySequence,
    expectedSubject: 'connection-*', historyChecked: true as const,
    deadline: checked.deadline, checkAccess };
  await store.append(command);
  const rows = await history(store, event.subject, event.silo, performance.now() + 10_000);
  const saved = foldConnection(rows).refreshClaim;
  if (!saved || !isDeepStrictEqual(saved.event, event)) {
    throw new Error('OAuth refresh claim unconfirmed');
  }
  return saved.sequence;
}

/** Start or join an internal attempt. Saving its reference grants no provider send or tool use. */
export async function startPersonalOAuthRefresh(store: EventStore, binding: Binding,
  rawSession: unknown, custody: Custody, raw: unknown,
  loadConfiguration: (serverId: string) => Promise<unknown>, db: Pick<Db, 'lock'>) {
  try {
    const session = sessionSchema.parse(rawSession);
    const input = refreshInput.parse(raw);
    if (session.siloId !== binding.silo || session.userId !== input.userId) {
      throw new Error('OAuth refresh refused');
    }
    const profile = { ...input, siloId: binding.silo };
    async function record() {
      const prepared = await prepareRefresh(store, binding, session, input, loadConfiguration);
      await checkPrivateRefresh(custody, prepared, binding.silo);
      const checked = await refreshAccess(store, binding, prepared, loadConfiguration);
      await checked.checkAccess();
      if (prepared.original) {
        return receipt(prepared.original);
      }
      if (!prepared.due) {
        return { status: 'not_due' as const };
      }
      return appendRefresh(store, binding.silo, prepared, checked);
    }
    return await withConnectionStage(db, profile, record);
  } catch {
    // Discard private dependency values and causes. A missing reply never permits another attempt.
    return { status: 'unknown' as const };
  }
}
type Input = z.infer<typeof refreshInput>;
type Session = z.infer<typeof sessionSchema>;
type Loader = (serverId: string) => Promise<unknown>;
type Prepared = Awaited<ReturnType<typeof prepareRefresh>>;

async function prepareRefresh(store: EventStore, binding: Binding, session: Session,
  input: Input, loadConfiguration: Loader) {
  const subject = `connection-${input.userId}-${input.serverId}-${input.profileId}`;
  const historyDeadline = performance.now() + 10_000;
  const rows = await history(store, subject, binding.silo, historyDeadline);
  const serverRows = await history(store, `mcp-${input.serverId}`, binding.silo, historyDeadline);
  const membership = await currentMembership(store, binding.silo, input.userId,
    undefined, historyDeadline);
  const configuration = oauthConfigurationSchema.parse(await loadConfiguration(input.serverId));
  const state = foldConnection(rows);
  const generation = refreshGeneration(state, input);
  const server = refreshServer(serverRows, configuration, input, binding.silo);
  if (generation.activation.endpointDigest !== server.endpointDigest ||
      generation.activation.configurationDigest !== oauthConfigurationDigest(configuration)) {
    throw new Error('OAuth configuration changed');
  }
  if (membership.positions.get(`member-${input.userId}`) !== session.memberRevision) {
    throw new Error('OAuth membership changed');
  }
  for (const row of rows) {
    if (row.event.commandId === input.changeRef && row !== generation.original) {
      throw new Error('OAuth change reference reused');
    }
  }
  const due = Date.now() >= generation.activation.account.expiresAt - 60_000;
  return { input, subject, membership, configuration, state, server, due, ...generation };
}
function refreshGeneration(state: ReturnType<typeof foldConnection>, input: Input) {
  const saved = state.data;
  const activation = saved?.activation;
  const original = state.refreshAttempt;
  const prior = original ? connectionRefreshStartedDataSchema.parse(original.event.data) : undefined;
  const expectedSequence = prior?.expectedSequence ?? state.sequence;
  if (!saved || activation?.reason !== 'oauth_confirmed' ||
      saved.userId !== input.userId || saved.serverId !== input.serverId ||
      saved.profile !== input.profileId || activation.connectionId !== input.connectionId ||
      activation.generation !== input.expectedGeneration ||
      expectedSequence !== input.expectedSequence) {
    throw new Error('OAuth generation changed');
  }
  return { saved, activation, original, expectedSequence };
}
function refreshServer(rows: StoredEvent[], configuration: z.infer<typeof oauthConfigurationSchema>,
  input: Input, siloId: string) {
  const server = connectionServer(rows, input.connectionId);
  const policy = toolPolicyFromRows(rows);
  if (!server.available || configuration.serverId !== input.serverId ||
      configuration.connectionId !== input.connectionId || policy.silo !== siloId ||
      configuration.policyRevision !== policy.policyRevision ||
      configuration.endpointDigest !== server.endpointDigest) {
    throw new Error('OAuth configuration changed');
  }
  return server;
}

async function checkPrivateRefresh(custody: Custody, prepared: Prepared, siloId: string,
  required = false) {
  const { input, original, due, activation, saved } = prepared;
  if (required || (!original && due)) {
    const stage: ConnectionStage = { siloId, userId: input.userId,
      serverId: input.serverId, profileId: input.profileId, connectionId: input.connectionId,
      purpose: 'personal', generation: activation.generation,
      endpointDigest: activation.endpointDigest, operationId: activation.operationId,
      expectedSequence: activation.expectedSequence, appendUntil: activation.appendUntil };
    const identity = { reference: saved.secretRef.slice('secret:'.length),
      uid: activation.uid, resourceVersion: activation.resourceVersion };
    if (!await custody.hasRefreshMaterial(stage, identity)) {
      throw new Error('OAuth refresh unavailable');
    }
  }
}

async function refreshAccess(store: EventStore, binding: Binding, prepared: Prepared,
  loadConfiguration: Loader, sequence = prepared.state.sequence) {
  const { input, subject, membership, configuration, server } = prepared;
  // Finish history and private reads before starting the original two-second access check.
  const subjects = [...membership.positions.keys()];
  const fresh = await authorityFence(store, performance.now(), subjects);
  const options = { requiredRole: 'member' as const, membership, fresh };
  await activeMember(store, binding, input.userId, options);
  const control = `connection-control-${input.userId}-${input.serverId}`;
  const categorySequence = await store.head('connection-*', fresh.deadline);
  async function checkAccess() {
    const current = oauthConfigurationSchema.parse(await loadConfiguration(input.serverId));
    if (!isDeepStrictEqual(current, configuration) ||
        await store.head(subject, fresh.deadline) !== sequence ||
        await store.head(control, fresh.deadline) !== 0 ||
        await store.head(`mcp-${input.serverId}`, fresh.deadline) !== server.sequence ||
        !Number.isFinite(server.expiresAt) || Date.now() >= server.expiresAt) {
      throw new Error('OAuth refresh access changed');
    }
    await fresh();
  }
  return { categorySequence, deadline: fresh.deadline, checkAccess };
}

async function appendRefresh(store: EventStore, siloId: string, prepared: Prepared,
  checked: Awaited<ReturnType<typeof refreshAccess>>) {
  const { input, subject, activation, expectedSequence } = prepared;
  const attemptId = connectionOperationId(siloId, subject, `${input.changeRef}-refresh`);
  const data = connectionRefreshStartedDataSchema.parse({ userId: input.userId,
    serverId: input.serverId, connectionId: input.connectionId, profile: input.profileId,
    attemptId, configurationDigest: activation.configurationDigest,
    generation: activation.generation, expectedSequence, scopes: activation.account.scopes });
  const event = { ...envelope(siloId, subject, 'connection.refresh_started', data, attemptId),
    commandId: input.changeRef, source: 'opencrane-server',
    principal: { kind: 'human' as const, id: input.userId } };
  const command = { event, expectedSequence: checked.categorySequence, expectedSubject: 'connection-*',
    historyChecked: true as const, deadline: checked.deadline, checkAccess: checked.checkAccess };
  const result = await store.append(command);
  if (result.status !== 'appended') {
    throw new Error('OAuth refresh unconfirmed');
  }
  const savedRows = await history(store, subject, siloId, performance.now() + 10_000);
  const attempt = foldConnection(savedRows).refreshAttempt;
  if (!attempt || attempt.sequence !== result.sequence || !isDeepStrictEqual(attempt.event, event)) {
    throw new Error('OAuth refresh unconfirmed');
  }
  return receipt(attempt);
}
function receipt(row: StoredEvent) {
  const data = connectionRefreshStartedDataSchema.parse(row.event.data);
  return { status: 'saved' as const, attemptId: data.attemptId, sequence: row.sequence,
    generation: data.generation, callsAvailable: false as const };
}
