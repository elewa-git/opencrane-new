import { createHash } from 'node:crypto';
import { foldRoutineHistory } from '@opencrane/authz';
import type { EventStore } from '@opencrane/event-store';
import type { RoutineState, companyCredentialReleaseSchema } from '@opencrane/events';
import type { z } from 'zod';
import { history } from './actor.ts';
import { foldCompanyConnection } from './company-bearer.ts';
import { companySelectionFacts, type CompanyProfileReader } from './company-selection.ts';
import { foldConnectionSelection } from './connection-selection.ts';
import { connectionServer } from './connection-server.ts';
import type { OAuthConfigurationLoader } from './oauth-selection.ts';
import { toolPolicyFromRows } from './tool-policy.ts';

type Release = z.infer<typeof companyCredentialReleaseSchema>;

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
      run.conversationId !== release.conversationId || run.turnId !== release.turnId ||
      run.controlRevision !== state.definition?.controlRevision ||
      !matchesDefinition(run, release)) {
    refuse();
  }
  return run;
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

async function requireCurrentProfileAndTool(store: EventStore, silo: string,
  release: Release, deadline: number) {
  const subject = `connection-company:${release.serverId}:${release.profileId}`;
  const rows = await history(store, subject, silo, deadline);
  const profile = foldCompanyConnection(rows);
  const saved = profile.data;
  const serverRows = await history(store, `mcp-${release.serverId}`, silo, deadline);
  const server = connectionServer(serverRows, release.connectionId);
  const policy = toolPolicyFromRows(serverRows);
  function matchesTool(tool: { name: string }) {
    return tool.name === release.toolName;
  }
  const tool = policy.tools.find(matchesTool);
  const accountCurrent = saved && profile.sequence === release.profileRevision &&
    profile.sequence === release.connectionRevision &&
    saved.activation.generation === release.generation &&
    saved.activation.connectionId === release.connectionId &&
    saved.activation.endpointDigest === server.endpointDigest;
  const toolCurrent = server.available && server.sequence === release.policyRevision &&
    policy.published && tool?.reviewed && tool.mode === 'allow' &&
    tool.revision === release.schemaDigest && tool.costCents === 0;
  if (!accountCurrent || !toolCurrent) {
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
