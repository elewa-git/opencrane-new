import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { z } from 'zod';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
import { decisionRecordedDataSchema, toolCredentialReleaseSchema,
  type EventEnvelope } from '@opencrane/events';
import { envelope, history } from './actor.ts';
import { foldConnection } from './bearer-connections.ts';
import { foldConnectionSelection } from './connection-selection.ts';
import { connectionServer } from './connection-server.ts';
import { MemberAccessRefused } from './member-authority.ts';
import { selectedOAuth, type OAuthConfigurationLoader } from './oauth-selection.ts';

type Release = z.infer<typeof toolCredentialReleaseSchema>;
type Access = { deadline: number; checkAccess: () => Promise<void> };
type Activation = NonNullable<ReturnType<typeof foldConnection>['data']>['activation'];

function digest(value: unknown) {
  const hash = createHash('sha256');
  hash.update(JSON.stringify(value));
  return hash.digest('hex');
}
function refuse(): never {
  throw new Error('Release unavailable');
}
function requireLifetime(release: Release) {
  const now = Date.now();
  if (release.issuedAt > now || release.expiresAt <= now ||
      release.expiresAt - release.issuedAt > 30_000 ||
      release.expiresAt <= release.issuedAt) {
    refuse();
  }
}
function requireDecision(rows: StoredEvent[], decisionId: string, release: Release) {
  const event = rows[0]?.event;
  const parsed = decisionRecordedDataSchema.safeParse(event?.data);
  if (rows.length !== 1 || event?.id !== decisionId || event.type !== 'decision.recorded' ||
      event.source !== 'models' || event.principal?.kind !== 'system' ||
      event.principal.id !== 'models' || !parsed.success) {
    refuse();
  }
  const decision = parsed.data;
  const expected = { ...decision, route: 'mcp', outcome: 'allow', release,
    requesterId: release.userId, assistantId: release.assistantId,
    conversationId: release.conversationId, turnId: release.turnId,
    requestId: release.requestId, permitId: release.permitId,
    serverId: release.serverId, toolName: release.toolName };
  if (!isDeepStrictEqual(decision, expected)) {
    refuse();
  }
  return event;
}
export async function credentialReleaseEvidence(store: EventStore, silo: string,
  decisionId: string, release: Release, loadConfiguration?: OAuthConfigurationLoader) {
  requireLifetime(release);
  const deadline = performance.now() + 10_000;
  const positions = new Map<string, number>();
  async function read(subject: string) {
    const rows = await history(store, subject, silo, deadline);
    positions.set(subject, rows.at(-1)?.sequence ?? 0);
    return rows;
  }
  const decisions = await read(`decision-${release.requestId}`);
  const decision = requireDecision(decisions, decisionId, release);
  const selectedRows = await read(`connection-selection-${release.userId}-${release.serverId}`);
  const selection = foldConnectionSelection(selectedRows);
  const profileRows = await read(
    `connection-${release.userId}-${release.serverId}-${release.profileId}`);
  const profile = foldConnection(profileRows);
  const control = `connection-control-${release.userId}-${release.serverId}`;
  const controlPosition = await store.head(control, deadline);
  positions.set(control, controlPosition);
  const serverRows = await read(`mcp-${release.serverId}`);
  const server = connectionServer(serverRows, release.connectionId);
  let oauth: Awaited<ReturnType<typeof selectedOAuth>> = null;
  if (loadConfiguration && selection.selected?.action === 'select') {
    oauth = await selectedOAuth(profileRows, serverRows, selection.selected,
      loadConfiguration, release.toolName);
    if (!oauth || Date.now() >= oauth.expiresAt) {
      refuse();
    }
  }
  requireSelection(selection, controlPosition, release, oauth?.profileRevision);
  requireProfile(profile, server, release, oauth !== null);
  const receipts = await read(`credential-${release.requestId}`);
  return { decision, positions, receipts, profile: profile.data!, oauth,
    expiresAt: Math.min(server.expiresAt, oauth?.expiresAt ?? Infinity) };
}
function requireSelection(selection: ReturnType<typeof foldConnectionSelection>,
  controlPosition: number, release: Release, oauthRevision?: number) {
  const selected = selection.selected;
  if (!selected || selected.action !== 'select' || selected.userId !== release.userId ||
      selected.serverId !== release.serverId || selected.connectionId !== release.connectionId ||
      selected.profileId !== release.profileId || selection.sequence !== release.selectionRevision ||
      (oauthRevision ?? selected.profileRevision) !== release.profileRevision || controlPosition !== 0) {
    refuse();
  }
}
function requireProfile(profile: ReturnType<typeof foldConnection>,
  server: ReturnType<typeof connectionServer>, release: Release, verified: boolean) {
  const saved = profile.data;
  if (!verified && profile.status !== 'saved_unverified') {
    refuse();
  }
  if (!saved ||
      profile.sequence !== release.profileRevision || saved.userId !== release.ownerId ||
      saved.serverId !== release.serverId || saved.profile !== release.profileId ||
      saved.activation.connectionId !== release.connectionId ||
      saved.activation.generation !== release.generation || !server.available ||
      server.sequence !== release.policyRevision ||
      saved.activation.endpointDigest !== server.endpointDigest) {
    refuse();
  }
  // Bind the account and granted scopes to saved metadata, never to caller labels.
  requireSavedAccount(saved.activation, release);
}
function requireSavedAccount(activation: Activation, release: Release) {
  const account = 'account' in activation ? activation.account : null;
  const scopes = account?.scopes ?? [];
  if (release.accountDigest !== digest(account) || release.scopeDigest !== digest(scopes)) {
    refuse();
  }
}
function auditEvent(silo: string, release: Release, decision: EventEnvelope) {
  const eventId = `${decision.id}:release`;
  const event = envelope(silo, `credential-${release.requestId}`, 'credential.released',
    release, eventId, new Date(release.issuedAt));
  event.correlation = { ...decision.correlation, request: decision.id,
    conversation: release.conversationId, turn: release.turnId, permit: release.permitId };
  return event;
}
function confirmed(rows: StoredEvent[], expected: EventEnvelope) {
  const row = rows[0];
  if (rows.length !== 1 || !row || row.sequence <= 0 ||
      !isDeepStrictEqual(row.event, expected)) {
    refuse();
  }
  // Return evidence only. A receipt cannot reconstruct a lease, even after a restart.
  return { status: 'confirmed' as const, eventId: row.event.id, sequence: row.sequence };
}

/** Audit an already authorised call. The trusted caller supplies live dispatch checks. */
export async function confirmCredentialRelease(store: EventStore, silo: string,
  requesterId: string, decisionId: string, raw: unknown,
  prepareAccess: () => Promise<Access>, action: 'append' | 'recover' | 'claim' = 'append',
  loadConfiguration?: OAuthConfigurationLoader) {
  let refusal: MemberAccessRefused | undefined;
  async function prepare() {
    const access = await prepareAccess();
    async function checkAccess() {
      try {
        await access.checkAccess();
      } catch (error) {
        if (error instanceof MemberAccessRefused) {
          // Keep the access refusal if the store reports a later dependency failure.
          refusal = error;
        }
        throw error;
      }
    }
    return { deadline: access.deadline, checkAccess };
  }
  try {
    const receipt = await confirm(store, silo, requesterId, decisionId, raw, prepare, action,
      loadConfiguration);
    if (refusal) {
      throw refusal;
    }
    return receipt;
  } catch (error) {
    if (refusal) {
      throw refusal;
    }
    if (error instanceof MemberAccessRefused) {
      throw error;
    }
    // Keep store failures and invalid input out of outward errors.
    return refuse();
  }
}
async function prepareEvidence(store: EventStore, silo: string, requesterId: string,
  decisionId: string, raw: unknown, loadConfiguration?: OAuthConfigurationLoader) {
  try {
    const release = toolCredentialReleaseSchema.parse(raw);
    if (release.userId !== requesterId || release.ownerId !== requesterId) {
      refuse();
    }
    const evidence = await credentialReleaseEvidence(store, silo, decisionId, release,
      loadConfiguration);
    return { release, evidence };
  } catch {
    return null;
  }
}
async function confirm(store: EventStore, silo: string, requesterId: string,
  decisionId: string, raw: unknown, prepareAccess: () => Promise<Access>,
  action: 'append' | 'recover' | 'claim', loadConfiguration?: OAuthConfigurationLoader) {
  // Finish validation and history before the caller starts its two-second access check.
  const prepared = await prepareEvidence(store, silo, requesterId, decisionId, raw, loadConfiguration);
  const access = await prepareAccess();
  // Report the caller's permission refusal before any validation or saved-evidence failure.
  if (!prepared) {
    refuse();
  }
  const { release, evidence } = prepared;
  const deadline = Math.min(access.deadline, performance.now() + 2000,
    performance.now() + release.expiresAt - Date.now());
  if (!Number.isFinite(deadline)) {
    refuse();
  }
  async function checkAccess() {
    await access.checkAccess();
    if (evidence.oauth && !await evidence.oauth.configurationCurrent()) {
      refuse();
    }
    for (const [subject, position] of evidence.positions) {
      if (await store.head(subject, deadline) !== position) {
        refuse();
      }
    }
    requireLifetime(release);
    if (!Number.isFinite(evidence.expiresAt) || Date.now() >= evidence.expiresAt ||
        performance.now() >= deadline) {
      refuse();
    }
  }
  const event = auditEvent(silo, release, evidence.decision);
  await checkAccess();
  if (evidence.receipts.length !== 0) {
    if (action === 'claim') {
      refuse();
    }
    return confirmed(evidence.receipts, event);
  }
  if (action === 'recover') {
    refuse();
  }
  const command = { event, expectedSequence: 0, historyChecked: true as const,
    checkAccess, deadline };
  const result = await store.append(command);
  if (result.status === 'unavailable') {
    throw result.cause;
  }
  if (action === 'claim' && result.outcome?.kind !== 'appended') {
    refuse();
  }
  // An ambiguous append returns no receipt. A later invocation reads the original id.
  const rows = await history(store, event.subject, silo, deadline);
  const receipt = confirmed(rows, event);
  evidence.positions.set(event.subject, receipt.sequence);
  await checkAccess();
  return receipt;
}
