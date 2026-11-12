import { createHash } from 'node:crypto';
import type { Binding } from '@opencrane/authz';
import type { EventStore } from '@opencrane/event-store';
import { history } from './actor.ts';
import { foldConnection } from './bearer-connections.ts';
import { readConnectionSelection } from './connection-selection.ts';
import { selectedPersonalAccount } from './personal-account.ts';
import { connectionAccount } from './connection-account.ts';
import type { OAuthConfigurationLoader } from './oauth-selection.ts';
import { toolPolicyFromRows } from './tool-policy.ts';

function digest(value: unknown) {
  const hash = createHash('sha256');
  hash.update(JSON.stringify(value));
  return hash.digest('hex');
}

/** Bind one verified choice to the authenticated requester before the short access check. */
export async function personalToolContext(store: EventStore, binding: Binding,
  requesterId: string, serverId: string, toolName: string,
  loadConfiguration: OAuthConfigurationLoader,
  boundSelection: { profileId: string; selectionRevision: number }) {
  const selected = await readConnectionSelection(store, binding, requesterId,
    serverId, loadConfiguration, toolName);
  if (selected.status !== 'verified' ||
      selected.profileId !== boundSelection.profileId ||
      selected.sequence !== boundSelection.selectionRevision) {
    throw new Error('Personal tool unavailable');
  }
  const deadline = performance.now() + 10_000;
  const profileSubject = `connection-${requesterId}-${serverId}-${selected.profileId}`;
  const profileRows = await history(store, profileSubject, binding.silo, deadline);
  const profile = foldConnection(profileRows);
  const serverRows = await history(store, `mcp-${serverId}`, binding.silo, deadline);
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

export type PersonalToolContext = Awaited<ReturnType<typeof personalToolContext>>;
