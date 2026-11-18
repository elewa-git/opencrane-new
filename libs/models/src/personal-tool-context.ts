import { sha256HexOfJson as digest } from '@opencrane/events/digest';
import type { z } from 'zod';
import type { legacyTurnSchema } from './decision-turn-token.ts';
import { parseMcpCall } from './mcp.ts';
import type { Binding } from '@opencrane/authz';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
import { history } from './actor.ts';
import { foldConnection } from './bearer-connections.ts';
import { readConnectionSelection } from './connection-selection.ts';
import { selectedPersonalAccount, type PersonalToolContext } from './personal-account.ts';
export type { PersonalToolContext } from './personal-account.ts';
import { assistantMayUsePersonalKey, readPersonalKeyAssistant } from './personal-key-consent.ts';
import { connectionAccount } from './connection-account.ts';
import type { OAuthConfigurationLoader } from './oauth-selection.ts';
import { toolPolicyFromRows } from './tool-policy.ts';

/** Bind one verified choice to the authenticated requester before the short access check. */
export interface PersonalToolRequest {
  assistantId: string;
  toolName: string;
  loadConfiguration: OAuthConfigurationLoader;
  boundSelection: { profileId: string; selectionRevision: number };
  serverRows?: StoredEvent[];
}

export async function personalToolContext(store: EventStore, binding: Binding,
  requesterId: string, serverId: string,
  request: PersonalToolRequest): Promise<PersonalToolContext> {
  const { assistantId, toolName, loadConfiguration, boundSelection } = request;
  const readOptions = { loadConfiguration, toolName };
  const selected = await readConnectionSelection(store, binding, requesterId, serverId, readOptions);
  if (selected.status !== 'verified' ||
      selected.profileId !== boundSelection.profileId ||
      selected.sequence !== boundSelection.selectionRevision) {
    throw new Error('Personal tool unavailable');
  }
  const deadline = performance.now() + 10_000;
  const assistantRows = await readPersonalKeyAssistant(store, binding.silo, assistantId, deadline);
  const consent = { ...selected, userId: requesterId };
  if (!assistantMayUsePersonalKey(consent, assistantId, assistantRows)) {
    throw new Error('Personal tool unavailable');
  }
  const profileSubject = `connection-${requesterId}-${serverId}-${selected.profileId}`;
  const profileRows = await history(store, profileSubject, binding.silo, deadline);
  const profile = foldConnection(profileRows);
  const serverRows = request.serverRows ?? await readServerRows(
    store, binding.silo, serverId, deadline);
  const policy = toolPolicyFromRows(serverRows);
  const saved = profile.data;
  if (!saved || profile.sequence !== selected.profileRevision ||
      saved.activation.generation !== selected.generation ||
      policy.accountMode !== 'personal' || !policy.published) {
    throw new Error('Personal tool unavailable');
  }
  const choice = { action: 'select' as const, userId: requesterId, serverId,
    connectionId: saved.activation.connectionId, profileId: selected.profileId,
    profileRevision: selected.profileRevision, expectedSequence: selected.sequence };
  const oauth = await selectedPersonalAccount(profileRows, serverRows, choice,
    loadConfiguration, toolName);
  if (!oauth || oauth.generation !== selected.generation ||
      Date.now() >= oauth.expiresAt) {
    throw new Error('Personal tool unavailable');
  }
  const account = connectionAccount(saved.activation);
  if (!account) throw new Error('Personal tool unavailable');
  return {
    requesterId, serverId, connectionId: saved.activation.connectionId,
    profileId: selected.profileId, profileRevision: selected.profileRevision,
    selectionRevision: selected.sequence, generation: selected.generation,
    policyRevision: policy.policyRevision, accountDigest: digest(account),
    scopeDigest: digest(account.scopes), accountLabel: account.subject,
    expiresAt: oauth.expiresAt,
  };
}

async function readServerRows(store: EventStore, silo: string, serverId: string, deadline: number) {
  return history(store, `mcp-${serverId}`, silo, deadline);
}

export interface PersonalCallRequest {
  assistantId: string;
  url: string | undefined;
  body: string;
  loadConfiguration: OAuthConfigurationLoader | undefined;
}

/** Prepare personal account history before the decision's short access check starts. */
export async function preparePersonalCall(store: EventStore, binding: Binding,
  turn: z.infer<typeof legacyTurnSchema>, request: PersonalCallRequest) {
  const match = /^\/authorize\/mcp\/([\w-]+)\/([\w-]+)$/u.exec(request.url ?? '');
  if (!match) throw new Error('Unknown MCP route');
  const serverId = match[1]!;
  const rows = await readServerRows(store, binding.silo, serverId, performance.now() + 10_000);
  const policy = toolPolicyFromRows(rows);
  if (policy.accountMode !== 'personal') return undefined;
  if (!request.loadConfiguration) throw new Error('Personal tool unavailable');
  const parsed = parseMcpCall(request.body);
  function matchesServer(selection: NonNullable<typeof turn.personalSelections>[number]) {
    return selection.serverId === serverId;
  }
  const boundSelection = turn.personalSelections?.find(matchesServer);
  if (!boundSelection) throw new Error('Personal tool unavailable');
  const personalRequest = { assistantId: request.assistantId, toolName: parsed.call.params.name,
    loadConfiguration: request.loadConfiguration, boundSelection, serverRows: rows };
  return personalToolContext(store, binding, turn.requester, serverId, personalRequest);
}
