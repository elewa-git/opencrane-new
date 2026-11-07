import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { foldRoutineHistory } from '@opencrane/authz';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
import type { RoutineState, companyCredentialReleaseSchema } from '@opencrane/events';
import { approvalDecidedDataSchema, approvalUsedDataSchema,
  toolApprovalRequestedDataSchema } from '@opencrane/events';
import { z } from 'zod';
import { history } from './actor.ts';
import { foldCompanyConnection } from './company-bearer.ts';
import { companySelectionFacts, type CompanyProfileReader } from './company-selection.ts';
import { foldConnectionSelection } from './connection-selection.ts';
import { connectionServer } from './connection-server.ts';
import type { OAuthConfigurationLoader } from './oauth-selection.ts';
import { toolPolicyFromRows } from './tool-policy.ts';

type Release = z.infer<typeof companyCredentialReleaseSchema>;
type Ask = z.infer<typeof toolApprovalRequestedDataSchema>;

function refuse(): never {
  throw new Error('Release unavailable');
}

function digest(value: unknown) {
  const hash = createHash('sha256');
  hash.update(JSON.stringify(value));
  return hash.digest('hex');
}

function matchesDefinition(run: NonNullable<RoutineState['activeRun']>, release: Release) {
  const definition = run.definition;
  return definition.ownerId === release.ownerId &&
    definition.assistantId === release.assistantId &&
    definition.payingGroupId === release.payingGroupId &&
    definition.connectionKind === 'company' &&
    definition.connectionId === release.connectionId &&
    definition.profileId === release.profileId &&
    definition.profileRevision === release.profileRevision &&
    definition.connectionRevision === release.connectionRevision &&
    definition.companyAccountId === release.companyAccountId;
}

function requireRun(state: RoutineState | undefined, release: Release) {
  const run = state?.activeRun;
  if (!state || state.status !== 'active' || state.stopRequested ||
      !state.activation || !run || run.occurrenceId !== release.occurrenceId ||
      run.rootId !== release.rootId ||
      run.conversationId !== release.conversationId || run.turnId !== release.turnId ||
      run.controlRevision !== state.definition?.controlRevision ||
      !matchesDefinition(run, release)) {
    refuse();
  }
  return run;
}

function requestRowMatches(row: StoredEvent | undefined) {
  return row?.event.type === 'tool.approval_requested' &&
    row.event.source === 'models' && row.event.principal?.kind === 'system' &&
    row.event.principal.id === 'models';
}

function decisionRowMatches(row: StoredEvent | undefined, ownerId: string) {
  return row?.event.type === 'approval.decided' &&
    row.event.source === 'opencrane-server' && row.event.principal?.kind === 'human' &&
    row.event.principal.id === ownerId;
}

function useRowMatches(row: StoredEvent | undefined) {
  return row?.event.type === 'approval.used' &&
    row.event.source === 'models' && row.event.principal?.kind === 'system' &&
    row.event.principal.id === 'models';
}

function requireAskRows(rows: StoredEvent[], release: Release) {
  const requested = rows[0];
  const decided = rows[1];
  const used = rows[2];
  const request = toolApprovalRequestedDataSchema.safeParse(requested?.event.data);
  const decision = approvalDecidedDataSchema.safeParse(decided?.event.data);
  const use = approvalUsedDataSchema.safeParse(used?.event.data);
  if (rows.length !== 3 || !request.success || !decision.success || !use.success ||
      !requestRowMatches(requested) || !decisionRowMatches(decided, release.ownerId) ||
      !useRowMatches(used)) {
    refuse();
  }
  return { requested: requested!, decided: decided!, used: used!,
    request: request.data, decision: decision.data, use: use.data };
}

function matchingRoutineBinding(saved: Ask, release: Release) {
  const expected = {
    routineId: release.routineId, occurrenceId: release.occurrenceId,
    rootId: release.rootId, threadId: release.threadId,
    payingGroupId: release.payingGroupId, profileId: release.profileId,
    profileRevision: release.profileRevision,
    connectionRevision: release.connectionRevision,
    selectionRevision: release.selectionRevision,
    companyAccountId: release.companyAccountId,
    accountDigest: release.accountDigest, scopeDigest: release.scopeDigest,
    destinationDigest: release.destinationDigest,
  };
  return isDeepStrictEqual(saved.routine, expected);
}

function matchingAskIdentity(saved: Ask, release: Release) {
  return saved.approvalId === release.approvalId &&
    saved.requesterId === release.ownerId &&
    saved.assistantId === release.assistantId &&
    saved.conversationId === release.conversationId && saved.turnId === release.turnId;
}

function matchingAskTool(saved: Ask, release: Release) {
  return saved.serverId === release.serverId && saved.tool === release.toolName &&
    saved.connectionId === release.connectionId && saved.profile === release.profileId &&
    saved.schemaDigest === release.schemaDigest &&
    saved.toolRevision === release.toolRevision &&
    saved.policySequence === release.policyRevision &&
    saved.argumentsDigest === release.argumentsDigest && !saved.missingFields?.length;
}

function askLifetimeCurrent(requested: StoredEvent, decided: StoredEvent,
  used: StoredEvent, saved: Ask, release: Release) {
  const expiresAt = Date.parse(saved.expiresAt);
  const lifetime = expiresAt - Date.parse(requested.event.time);
  return lifetime > 0 && lifetime <= 900_000 &&
    Date.parse(decided.event.time) <= expiresAt &&
    Date.parse(used.event.time) <= expiresAt &&
    Date.now() < expiresAt && release.expiresAt <= expiresAt;
}

/** Require the original owner's exact Ask and its single use before releasing company access. */
export async function routineCompanyAskFacts(store: EventStore, silo: string,
  release: Release, deadline: number) {
  const subject = `approval-${release.approvalId}`;
  const rows = await history(store, subject, silo, deadline);
  const { requested, decided, used, request, decision, use } = requireAskRows(rows, release);
  const exactDecision = decision.approvalId === release.approvalId &&
    decision.decidedBy === release.ownerId && decision.decision === 'approved';
  const exactUse = use.approvalId === release.approvalId && use.permitId === release.permitId;
  if (!matchingRoutineBinding(request, release) ||
      !matchingAskIdentity(request, release) || !matchingAskTool(request, release) ||
      !exactDecision || !exactUse ||
      !askLifetimeCurrent(requested, decided, used, request, release)) {
    refuse();
  }
  return { subject, position: used.sequence, expiresAt: Date.parse(request.expiresAt) };
}

async function activeRun(store: EventStore, silo: string, release: Release, deadline: number) {
  const subject = `routine-${release.routineId}`;
  const rows = await history(store, subject, silo, deadline);
  let state: RoutineState | undefined;
  const completed = new Map<string, NonNullable<RoutineState['activeRun']>>();
  for (const row of rows) {
    state = foldRoutineHistory(state, row.event, completed);
  }
  const run = requireRun(state, release);
  const position = rows.at(-1)?.sequence ?? 0;
  async function executionCurrent() {
    // Check the saved run separately from the short access watch.
    const latest = await store.head(subject, performance.now() + 10_000);
    if (latest !== position) {
      refuse();
    }
  }
  return { executionCurrent, frozenScopes: run.definition.scopes };
}

async function selectedChoice(store: EventStore, silo: string, release: Release,
  deadline: number) {
  const subject = `connection-selection-${release.ownerId}-${release.serverId}`;
  const rows = await history(store, subject, silo, deadline);
  const selection = foldConnectionSelection(rows);
  const choice = selection.selected;
  if (!choice || choice.action !== 'select' || choice.ownerKind !== 'company' ||
      choice.profileId !== release.profileId ||
      choice.connectionId !== release.connectionId ||
      choice.profileRevision !== release.profileRevision ||
      selection.sequence !== release.selectionRevision) {
    refuse();
  }
  return { choice, subject, sequence: selection.sequence };
}

async function checkedCompany(store: EventStore, silo: string, release: Release,
  choice: Awaited<ReturnType<typeof selectedChoice>>['choice'],
  loadConfiguration: OAuthConfigurationLoader, readProfile: CompanyProfileReader) {
  const facts = await companySelectionFacts(store, silo, choice,
    loadConfiguration, readProfile);
  if (facts.accountId !== release.companyAccountId ||
      facts.binding.accountDigest !== release.accountDigest ||
      facts.binding.generation !== release.generation ||
      digest(facts.scopes) !== release.scopeDigest) {
    refuse();
  }
  return facts;
}

function requireRequestedToolScopes(toolName: string, toolScopes: Record<string, string[]>,
  verifiedScopes: string[], frozenScopes: string[]) {
  const requiredScopes = toolScopes[toolName];
  if (!requiredScopes) {
    refuse();
  }
  // Keep the saved routine within the scopes accepted when its run began.
  for (const scope of requiredScopes) {
    if (!verifiedScopes.includes(scope) || !frozenScopes.includes(scope)) {
      refuse();
    }
  }
}

function isRegistration(row: StoredEvent) {
  return row.event.type === 'mcp.server_registered';
}

function currentDestination(serverRows: StoredEvent[]) {
  const registration = serverRows.findLast(isRegistration);
  const registered = z.object({ kind: z.enum(['hosted', 'remote']),
    locator: z.string() }).safeParse(registration?.event.data);
  if (!registered.success) {
    refuse();
  }
  let destination = `Hosted: ${registered.data.locator}`;
  if (registered.data.kind === 'remote') {
    destination = new URL(registered.data.locator).origin;
  }
  return destination;
}

function accountMatches(profile: ReturnType<typeof foldCompanyConnection>,
  server: ReturnType<typeof connectionServer>, release: Release) {
  const saved = profile.data;
  return saved && profile.sequence === release.profileRevision &&
    profile.sequence === release.connectionRevision &&
    saved.activation.generation === release.generation &&
    saved.activation.connectionId === release.connectionId &&
    saved.activation.endpointDigest === server.endpointDigest;
}

function toolMatches(policy: ReturnType<typeof toolPolicyFromRows>,
  server: ReturnType<typeof connectionServer>, release: Release) {
  function matchesTool(tool: { name: string }) {
    return tool.name === release.toolName;
  }
  const tool = policy.tools.find(matchesTool);
  return server.available && server.sequence === release.policyRevision &&
    policy.published && tool?.reviewed && tool.mode !== 'block' &&
    tool.revision === release.toolRevision && tool.costCents === 0 &&
    policy.catalogue?.schemaDigest === release.schemaDigest;
}

async function requireCurrentProfileAndTool(store: EventStore, silo: string,
  release: Release, deadline: number) {
  const subject = `connection-company:${release.serverId}:${release.profileId}`;
  const rows = await history(store, subject, silo, deadline);
  const profile = foldCompanyConnection(rows);
  const serverRows = await history(store, `mcp-${release.serverId}`, silo, deadline);
  const server = connectionServer(serverRows, release.connectionId);
  const policy = toolPolicyFromRows(serverRows);
  const destination = currentDestination(serverRows);
  if (!accountMatches(profile, server, release) || !toolMatches(policy, server, release) ||
      digest(destination) !== release.destinationDigest) {
    refuse();
  }
}

/** Read the saved run and company choice before the caller starts its short access check. */
export async function routineCompanyReleaseFacts(store: EventStore, silo: string,
  release: Release, loadConfiguration: OAuthConfigurationLoader,
  readProfile: CompanyProfileReader) {
  const deadline = performance.now() + 10_000;
  const run = await activeRun(store, silo, release, deadline);
  const selection = await selectedChoice(store, silo, release, deadline);
  const facts = await checkedCompany(store, silo, release, selection.choice,
    loadConfiguration, readProfile);
  requireRequestedToolScopes(release.toolName, facts.toolScopes, facts.scopes, run.frozenScopes);
  await requireCurrentProfileAndTool(store, silo, release, deadline);
  const positions = new Map(facts.positions);
  positions.set(selection.subject, selection.sequence);
  return { positions, expiresAt: facts.expiresAt,
    configurationCurrent: facts.oauth.configurationCurrent,
    executionCurrent: run.executionCurrent };
}
