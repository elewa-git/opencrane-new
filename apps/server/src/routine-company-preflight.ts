import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { snapshotPositions, type EventStore, type StoredEvent } from '@opencrane/event-store';
import { grantStream, memberAuthorisation, type Binding } from '@opencrane/authz';
import { grantGivenDataSchema, grantRevokedDataSchema,
  mcpOAuthConfigurationDataSchema } from '@opencrane/events';
import type { RoutineState } from '@opencrane/events';
import { companySelectionFacts, foldCompanyConnection, foldConnectionSelection,
  groupMembership, history, type CompanyProfileReader,
  readCurrentCompanyProfile, toolPolicyFromRows, type OAuthConfigurationLoader }
  from '@opencrane/models';

type Run = NonNullable<RoutineState['activeRun']>;

function destinationDigest(rows: StoredEvent[]) {
  function isRegistration(row: StoredEvent) {
    return row.event.type === 'mcp.server_registered';
  }
  const registration = rows.findLast(isRegistration);
  const data = registration?.event.data;
  if (!data || typeof data !== 'object' || !('kind' in data) ||
      data.kind !== 'remote' || !('locator' in data) ||
      typeof data.locator !== 'string') refuse();
  const destination = new URL(data.locator).origin;
  const hash = createHash('sha256');
  hash.update(JSON.stringify(destination));
  return hash.digest('hex');
}

function matchesExactTool(rows: StoredEvent[], run: Run) {
  const saved = run.definition.tool;
  if (!saved || saved.costCents !== 0) return false;
  const policy = toolPolicyFromRows(rows);
  const savedName = saved.name;
  function matchesName(tool: (typeof policy.tools)[number]) {
    return tool.name === savedName;
  }
  const current = policy.tools.find(matchesName);
  return policy.published && policy.connectionId === run.definition.connectionId &&
    policy.policyRevision === saved.policyRevision &&
    policy.catalogue?.schemaDigest === saved.schemaDigest &&
    destinationDigest(rows) === saved.destinationDigest &&
    current?.reviewed === true && current.mode === 'allow' && current.costCents === 0 &&
    current.revision === saved.revision;
}

function requireToolScopes(run: Run,
  facts: Awaited<ReturnType<typeof companySelectionFacts>>) {
  const saved = run.definition.tool;
  if (!saved) refuse();
  const requiredScopes = facts.toolScopes[saved.name];
  if (!requiredScopes) refuse();
  for (const scope of requiredScopes) {
    if (!facts.scopes.includes(scope) || !run.definition.scopes.includes(scope)) refuse();
  }
}

function requireExactTool(rows: StoredEvent[], run: Run,
  facts: Awaited<ReturnType<typeof companySelectionFacts>>) {
  if (!matchesExactTool(rows, run)) refuse();
  requireToolScopes(run, facts);
}

function requireRecordedConfiguration(rows: StoredEvent[], serverId: string, digest: string) {
  function isConfigurationChange(row: StoredEvent) {
    return row.event.type === 'mcp.oauth_configuration_recorded';
  }
  const latest = rows.findLast(isConfigurationChange);
  if (!latest) refuse();
  const change = mcpOAuthConfigurationDataSchema.parse(latest.event.data);
  if (change.serverId !== serverId || change.status !== 'ready' ||
      change.configurationDigest !== digest) refuse();
}

function refuse(): never {
  throw new Error('Routine company unavailable');
}

function requireChoice(rows: StoredEvent[], run: Run) {
  const selection = foldConnectionSelection(rows);
  const choice = selection.selected;
  const definition = run.definition;
  if (!choice || choice.action !== 'select' || choice.ownerKind !== 'company' ||
      choice.userId !== definition.ownerId || choice.connectionId !== definition.connectionId ||
      choice.profileId !== definition.profileId ||
      choice.profileRevision !== definition.profileRevision) {
    refuse();
  }
  return { choice, sequence: selection.sequence };
}

function requireSavedProfile(rows: StoredEvent[], run: Run) {
  const profile = foldCompanyConnection(rows);
  const saved = profile.data;
  const definition = run.definition;
  if ((profile.status !== 'saved_unverified' && profile.status !== 'verified') || !saved ||
      profile.sequence !== definition.profileRevision ||
      profile.sequence !== definition.connectionRevision ||
      saved.serverId !== definition.serverId ||
      saved.profile !== definition.profileId ||
      saved.activation.connectionId !== definition.connectionId) {
    refuse();
  }
  return saved;
}

function readGrant(row: StoredEvent, serverId: string) {
  if (row.event.type !== 'grant.given' && row.event.type !== 'grant.revoked') refuse();
  const granted = row.event.type === 'grant.given';
  const schema = granted ? grantGivenDataSchema : grantRevokedDataSchema;
  const data = schema.parse(row.event.data);
  if (data.resourceType !== 'mcp_server' || data.resourceId !== serverId) refuse();
  return { granted, granteeId: data.granteeId, granteeKind: data.granteeKind };
}

function foldServerGrants(rows: StoredEvent[], run: Run, serverId: string) {
  const definition = run.definition;
  const teamGrants = new Map<string, boolean>();
  const teamReceipts = new Map<string, StoredEvent[]>();
  const relevantReceipts: StoredEvent[] = [];
  let ownerGranted = false;
  let assistantGranted = false;
  for (const row of rows) {
    const grant = readGrant(row, serverId);
    const legacyRevocation = !grant.granted && grant.granteeKind === undefined;
    if (grant.granteeId === definition.ownerId &&
        (grant.granteeKind === 'member' || legacyRevocation)) {
      ownerGranted = grant.granted;
      relevantReceipts.push(row);
    }
    if (grant.granteeId === definition.assistantId &&
        (grant.granteeKind === 'assistant' || legacyRevocation)) {
      assistantGranted = grant.granted;
      relevantReceipts.push(row);
    }
    if (grant.granteeKind === 'team' || legacyRevocation) {
      teamGrants.set(grant.granteeId, grant.granted);
      const receipts = teamReceipts.get(grant.granteeId) ?? [];
      receipts.push(row);
      teamReceipts.set(grant.granteeId, receipts);
    }
  }
  return { ownerGranted, assistantGranted, teamGrants, teamReceipts, relevantReceipts };
}

async function requireTeamGrants(store: EventStore, binding: Binding, silo: string,
  run: Run, deadline: number, saved: ReturnType<typeof foldServerGrants>,
  positions: Map<string, number>) {
  let ownerGranted = saved.ownerGranted;
  for (const [teamId, granted] of saved.teamGrants) {
    if (!granted) continue;
    const teamSubject = `team-${teamId}`;
    const teamRows = await history(store, teamSubject, silo, deadline);
    positions.set(teamSubject, teamRows.at(-1)?.sequence ?? 0);
    try {
      await groupMembership(store, silo, run.definition.ownerId, teamId, binding, deadline);
      ownerGranted = true;
      saved.relevantReceipts.push(...saved.teamReceipts.get(teamId) ?? []);
    } catch {
      // A grant to a group gives no access without current group membership.
    }
  }
  return ownerGranted;
}

async function requireServerGrants(store: EventStore, binding: Binding, silo: string,
  run: Run, deadline: number) {
  if (binding.silo !== silo) refuse();
  const definition = run.definition;
  const serverId = definition.serverId!;
  const subject = grantStream('mcp_server', serverId);
  const rows = await history(store, subject, silo, deadline);
  const positions = new Map([[subject, rows.at(-1)?.sequence ?? 0]]);
  const saved = foldServerGrants(rows, run, serverId);
  const ownerGranted = await requireTeamGrants(store, binding, silo, run,
    deadline, saved, positions);
  if (!ownerGranted || !saved.assistantGranted) refuse();
  const auth = memberAuthorisation(binding);
  for (const row of saved.relevantReceipts) {
    if (!await auth.applied(row.event.id)) refuse();
  }
  const owner = await auth.use('person', definition.ownerId, 'mcp_server', serverId);
  const assistant = await auth.use('assistant', definition.assistantId, 'mcp_server', serverId);
  if (owner.status !== 'ok' || !owner.allowed ||
      assistant.status !== 'ok' || !assistant.allowed) refuse();
  return positions;
}

/** Check the exact company choice and verified profile after the recorded computer wakes. */
export async function checkRoutineCompanyPreflight(store: EventStore, binding: Binding, silo: string,
  run: Run, computerGeneration: number, loadConfiguration: OAuthConfigurationLoader,
  readProfile: CompanyProfileReader) {
  try {
    const definition = run.definition;
    if (definition.connectionKind !== 'company' || !definition.serverId ||
        computerGeneration < 1) refuse();
    const deadline = performance.now() + 10_000;
    const selectionSubject =
      `connection-selection-${definition.ownerId}-${definition.serverId}`;
    const selectionRows = await history(store, selectionSubject, silo, deadline);
    const selected = requireChoice(selectionRows, run);
    let savedProfile: ReturnType<typeof requireSavedProfile> | undefined;
    let profileRows: StoredEvent[] | undefined;
    let profileEvidence: unknown;
    async function checkedReader(rows: StoredEvent[]) {
      savedProfile = requireSavedProfile(rows, run);
      profileRows = rows;
      // Keep the original account separate if a trusted reader reuses a mutable object.
      profileEvidence = structuredClone(await readProfile(rows));
      return profileEvidence;
    }
    const facts = await companySelectionFacts(store, silo, selected.choice,
      loadConfiguration, checkedReader);
    if (!savedProfile || facts.accountId !== definition.companyAccountId ||
        facts.binding.accountDigest !== selected.choice.accountDigest ||
        facts.binding.generation !== savedProfile.activation.generation ||
        facts.binding.generation !== selected.choice.generation) {
      refuse();
    }
    for (const scope of definition.scopes) {
      if (!facts.scopes.includes(scope)) refuse();
    }
    const serverRows = await history(store, `mcp-${definition.serverId}`, silo, deadline);
    requireExactTool(serverRows, run, facts);
    requireRecordedConfiguration(serverRows, definition.serverId,
      facts.oauth.configurationDigest);
    const positions = new Map(facts.positions);
    positions.set(selectionSubject, selected.sequence);
    const grants = await requireServerGrants(store, binding, silo, run, deadline);
    for (const [subject, position] of grants) positions.set(subject, position);
    async function confirmCurrent() {
      try {
        const currentDeadline = performance.now() + 2_000;
        if (!profileRows || !isDeepStrictEqual(await readProfile(profileRows), profileEvidence) ||
            Date.now() >= facts.expiresAt || !await facts.oauth.configurationCurrent()) {
          refuse();
        }
        // Check all company streams at one log position. A guarded append also checks
        // the global position it captured before calling this function.
        const snapshot = await snapshotPositions(store, positions, currentDeadline);
        if (!await facts.oauth.configurationCurrent()) refuse();
        if (Date.now() >= facts.expiresAt) refuse();
        return snapshot;
      } catch {
        refuse();
      }
    }
    await confirmCurrent();
    return { occurrenceId: run.occurrenceId, rootId: run.rootId,
      computerGeneration, configurationDigest: facts.oauth.configurationDigest, confirmCurrent };
  } catch {
    refuse();
  }
}

/** Prepare one internal company check using saved records and private credential custody. */
export function routineCompanyPreflightFromCustody(store: EventStore, binding: Binding,
  silo: string, loadConfiguration: OAuthConfigurationLoader,
  custody: Parameters<typeof readCurrentCompanyProfile>[0]) {
  const readProfile = readCurrentCompanyProfile(custody);
  async function preflight(run: Run, computerGeneration: number) {
    return checkRoutineCompanyPreflight(store, binding, silo, run, computerGeneration,
      loadConfiguration, readProfile);
  }
  return preflight;
}
