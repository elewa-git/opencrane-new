import type { StoredEvent } from '@opencrane/event-store';
import type { connectionSelectedDataSchema } from '@opencrane/events';
import type { z } from 'zod';
import { foldConnection } from './bearer-connections.ts';
import { oauthConfigurationDigest, oauthConfigurationSchema } from './oauth-attempt.ts';
import { toolPolicyFromRows } from './tool-policy.ts';

type Selection = Extract<z.infer<typeof connectionSelectedDataSchema>, { action: 'select' }>;
export type OAuthConfigurationLoader = (serverId: string) => Promise<unknown>;

/** Check saved account evidence only. No result from here permits a credential release. */
export async function selectedOAuth(rows: StoredEvent[], serverRows: StoredEvent[],
  selection: Selection, loadConfiguration?: OAuthConfigurationLoader, toolName?: string) {
  const current = foldConnection(rows);
  function beforeChoice(row: StoredEvent) {
    return row.sequence <= selection.profileRevision;
  }
  const originalRows = rows.filter(beforeChoice);
  const original = foldConnection(originalRows);
  const account = matchingAccount(current, original, selection);
  if (!loadConfiguration || !account) {
    return null;
  }
  const configuration = await configurationFor(loadConfiguration, selection.serverId);
  const configurationDigest = oauthConfigurationDigest(configuration);
  const policy = toolPolicyFromRows(serverRows);
  if (configurationDigest !== account.configurationDigest ||
      configuration.serverId !== selection.serverId ||
      configuration.connectionId !== selection.connectionId ||
      configuration.policyRevision !== policy.policyRevision ||
      configuration.endpointDigest !== account.endpointDigest ||
      configuration.issuer !== account.account.issuer ||
      !hasScopes(account.account.scopes, configuration.protocolScopes)) {
    return null;
  }
  if (toolName !== undefined && !toolEligible(policy, configuration, account.account.scopes, toolName)) {
    return null;
  }
  const loader = loadConfiguration;
  async function configurationCurrent() {
    const parsed = await configurationFor(loader, selection.serverId);
    return oauthConfigurationDigest(parsed) === configurationDigest;
  }
  return { generation: account.generation, profileRevision: current.sequence,
    expiresAt: account.account.expiresAt, configurationCurrent };
}

function matchingAccount(current: ReturnType<typeof foldConnection>,
  original: ReturnType<typeof foldConnection>, selection: Selection) {
  const saved = current.data;
  if (!saved || saved.activation.reason !== 'oauth_confirmed') {
    return null;
  }
  const account = saved.activation;
  const chosen = original.data?.activation;
  if (chosen?.reason !== 'oauth_confirmed') {
    return null;
  }
  if (original.sequence !== selection.profileRevision || saved.userId !== selection.userId ||
      saved.serverId !== selection.serverId || saved.profile !== selection.profileId ||
      account.connectionId !== selection.connectionId ||
      account.account.issuer !== chosen.account.issuer ||
      account.account.subject !== chosen.account.subject ||
      account.configurationDigest !== chosen.configurationDigest) {
    return null;
  }
  return account;
}

function toolEligible(policy: ReturnType<typeof toolPolicyFromRows>,
  configuration: z.infer<typeof oauthConfigurationSchema>, granted: string[], toolName: string) {
  function namedTool(tool: { name: string }) {
    return tool.name === toolName;
  }
  const tool = policy.tools.find(namedTool);
  const required = configuration.toolScopes[toolName];
  return tool?.reviewed && tool.mode !== 'block' && required && hasScopes(granted, required);
}

async function configurationFor(load: OAuthConfigurationLoader, serverId: string) {
  try {
    return oauthConfigurationSchema.parse(await load(serverId));
  } catch {
    throw new Error('Selection configuration unavailable');
  }
}

function hasScopes(granted: string[], required: string[]) {
  for (const scope of required) {
    if (!granted.includes(scope)) {
      return false;
    }
  }
  return true;
}
