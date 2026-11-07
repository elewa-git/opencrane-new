import { z } from 'zod';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
import { history } from './actor.ts';
import { foldCompanyConnection } from './company-bearer.ts';
import { foldCompanyOptIn } from './company-opt-in.ts';
import { connectionServer } from './connection-server.ts';
import { oauthConfigurationDigest, oauthConfigurationSchema } from './oauth-attempt.ts';
import type { OAuthConfigurationLoader } from './oauth-selection.ts';
import { toolPolicyFromRows } from './tool-policy.ts';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/u);
const digest = z.string().regex(/^[0-9a-f]{64}$/u);
const evidenceSchema = z.strictObject({
  status: z.literal('verified'), siloId: id, serverId: id, profileId: id,
  ownerKind: z.literal('company'), connectionId: id, profileRevision: z.int().positive(),
  generation: z.int().positive(), accountDigest: digest, configurationDigest: digest,
  scopes: z.array(z.string()).max(64), expiresAt: z.int().positive(),
});
// Accept only a trusted, pure reader of saved verification evidence. No live reader exists yet.
export type CompanyProfileReader = (rows: StoredEvent[]) => unknown;
type Choice = { serverId: string; connectionId: string; profileId: string; profileRevision: number };

export async function companySelectionFacts(store: EventStore, silo: string, choice: Choice,
  loadConfiguration?: OAuthConfigurationLoader, readProfile: CompanyProfileReader = foldCompanyConnection) {
  const deadline = performance.now() + 10_000;
  const subject = `connection-company:${choice.serverId}:${choice.profileId}`;
  const rows = await history(store, subject, silo, deadline);
  const evidence = evidenceSchema.safeParse(readProfile(rows));
  if (!evidence.success || !loadConfiguration) {
    throw new Error('Selection unavailable');
  }
  const account = evidence.data;
  const serverSubject = `mcp-${choice.serverId}`;
  const serverRows = await history(store, serverSubject, silo, deadline);
  // Keep personal as the interactive account mode, even for an explicit company choice.
  const server = connectionServer(serverRows, choice.connectionId);
  const policy = toolPolicyFromRows(serverRows);
  const optInSubject = `connection-company-${choice.serverId}`;
  const choices = await history(store, optInSubject, silo, deadline);
  const installation = { silo, serverId: choice.serverId, connectionId: choice.connectionId,
    registrationRevision: server.registrationRevision ?? 0 };
  const optIn = foldCompanyOptIn(choices, installation);
  const configuration = oauthConfigurationSchema.parse(await loadConfiguration(choice.serverId));
  const configurationDigest = oauthConfigurationDigest(configuration);
  const sequence = rows.at(-1)?.sequence ?? 0;
  const profileMatches = matchesChoice(account, choice, silo, sequence);
  const configurationMatches = matchesConfiguration(configuration, choice, server, policy);
  if (!server.available || !optIn.enabled || !profileMatches || !configurationMatches ||
      configurationDigest !== account.configurationDigest ||
      !hasUsableTool(policy, configuration, account.scopes)) {
    throw new Error('Selection unavailable');
  }
  const loader = loadConfiguration;
  async function configurationCurrent() {
    const current = oauthConfigurationSchema.parse(await loader(choice.serverId));
    return oauthConfigurationDigest(current) === configurationDigest;
  }
  const positions = new Map([[subject, sequence], [serverSubject, server.sequence],
    [optInSubject, optIn.sequence]]);
  const binding = { ownerKind: 'company' as const, siloId: silo,
    generation: account.generation, accountDigest: account.accountDigest };
  const expiresAt = Math.min(server.expiresAt, account.expiresAt);
  if (Date.now() >= expiresAt) {
    throw new Error('Selection unavailable');
  }
  const oauth = { profileRevision: sequence, configurationCurrent };
  return { binding, positions, expiresAt, connectionId: choice.connectionId, available: true, oauth };
}

function matchesConfiguration(configuration: z.infer<typeof oauthConfigurationSchema>,
  choice: Choice, server: ReturnType<typeof connectionServer>,
  policy: ReturnType<typeof toolPolicyFromRows>) {
  return configuration.serverId === choice.serverId &&
    configuration.connectionId === choice.connectionId &&
    configuration.endpointDigest === server.endpointDigest &&
    configuration.policyRevision === policy.policyRevision;
}

function matchesChoice(account: z.infer<typeof evidenceSchema>, choice: Choice,
  silo: string, sequence: number) {
  return account.siloId === silo && account.serverId === choice.serverId &&
    account.profileId === choice.profileId && account.connectionId === choice.connectionId &&
    account.profileRevision === sequence && sequence === choice.profileRevision;
}

function hasUsableTool(policy: ReturnType<typeof toolPolicyFromRows>,
  configuration: z.infer<typeof oauthConfigurationSchema>, scopes: string[]) {
  for (const scope of configuration.protocolScopes) {
    if (!scopes.includes(scope)) {
      return false;
    }
  }
  for (const tool of policy.tools) {
    const required = configuration.toolScopes[tool.name];
    if (!tool.reviewed || tool.mode === 'block' || !required) {
      continue;
    }
    function granted(scope: string) {
      return scopes.includes(scope);
    }
    if (required.every(granted)) {
      return true;
    }
  }
  return false;
}
