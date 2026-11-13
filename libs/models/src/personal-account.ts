import type { StoredEvent } from '@opencrane/event-store';
import type { connectionCreatedDataSchema, connectionSelectedDataSchema } from '@opencrane/events';
import type { z } from 'zod';
import { foldConnection } from './bearer-connections.ts';
import { connectionAccount, sameAccountIdentity, selectedProfileMatches } from './connection-account.ts';
import { selectedOAuth, type OAuthConfigurationLoader } from './oauth-selection.ts';
import { toolPolicyFromRows } from './tool-policy.ts';

type Selection = Extract<z.infer<typeof connectionSelectedDataSchema>, { action: 'select' }>;

/** Share verified account eligibility across selection, turn admission and per-call release. */
export async function selectedPersonalAccount(rows: StoredEvent[], serverRows: StoredEvent[],
  selection: Selection, loadConfiguration?: OAuthConfigurationLoader, toolName?: string) {
  const profile = foldConnection(rows);
  const saved = profile.data;
  if (saved?.activation.reason === 'oauth_confirmed') {
    return selectedOAuth(rows, serverRows, selection, loadConfiguration, toolName);
  }
  const verification = saved?.activation.verification;
  if (!saved || !verification || profile.status !== 'saved_unverified' ||
      !selectedProfileMatches(saved, selection)) {
    return null;
  }
  function beforeChoice(row: StoredEvent) {
    return row.sequence <= selection.profileRevision;
  }
  const originalRows = rows.filter(beforeChoice);
  const original = foldConnection(originalRows);
  const originalAccount = original.data && connectionAccount(original.data.activation);
  if (original.sequence !== selection.profileRevision || !originalAccount ||
      !sameAccountIdentity(verification.account, originalAccount)) return null;
  const policy = toolPolicyFromRows(serverRows);
  if (!matchesReviewedIdentity(policy, verification, toolName)) return null;
  function configurationCurrent() {
    return Promise.resolve(true);
  }
  return { generation: saved.activation.generation, profileRevision: profile.sequence,
    expiresAt: Math.min(verification.account.expiresAt, Date.parse(policy.expiresAt ?? '')),
    configurationCurrent };
}

type Policy = ReturnType<typeof toolPolicyFromRows>;
type Activation = NonNullable<z.infer<typeof connectionCreatedDataSchema>['activation']>;
type BearerActivation = Exclude<Activation, { reason: 'oauth_confirmed' }>;
type Verification = NonNullable<BearerActivation['verification']>;

function matchesReviewedIdentity(policy: Policy, verification: Verification, toolName?: string) {
  function identityMatches(tool: Policy['tools'][number]) {
    return tool.name === verification.toolName && tool.revision === verification.toolRevision &&
      tool.readOnly && tool.reviewed && tool.costCents === 0;
  }
  function toolMatches(tool: Policy['tools'][number]) {
    return tool.name === toolName && tool.reviewed && tool.mode !== 'block';
  }
  return policy.published && policy.accountMode === 'personal' &&
    policy.identityTool === verification.toolName && policy.tools.some(identityMatches) &&
    (toolName === undefined || policy.tools.some(toolMatches));
}
