import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { StoredEvent } from '@opencrane/event-store';
import type { connectionCustody } from './connection-custody.ts';
import { connectionOperationId } from './bearer-connections.ts';
import { connectionServer } from './connection-server.ts';
import { remoteEndpoint } from './address-policy.ts';
import { toolPolicyFromRows } from './tool-policy.ts';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/u);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const scope = z.string().regex(/^[\x21\x23-\x5b\x5d-\x7e]{1,200}$/u);
const scopes = z.array(scope).max(64);
const toolName = z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/u);
const contextSchema = z.strictObject({
  siloId: id, userId: id, serverId: id, connectionId: id, profileId: id, changeRef: id,
  sessionDigest: digestSchema, expectedSequence: z.int().nonnegative(),
  memberRevision: z.int().positive().optional(),
});
export const oauthConfigurationSchema = z.strictObject({
  serverId: id, connectionId: id, endpointDigest: digestSchema, policyRevision: z.int().positive(),
  issuer: z.string().max(2048), consentEndpoint: z.string().max(2048),
  redirectUri: z.string().max(2048), clientId: id,
  protocolScopes: scopes, toolScopes: z.record(toolName, scopes),
});
const privateSchema = z.strictObject({
  state: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  verifier: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
});

function digest(value: string, encoding: 'hex' | 'base64url' = 'hex') {
  const hash = createHash('sha256');
  hash.update(value);
  return hash.digest(encoding);
}
function privateMaterial() {
  const state = randomBytes(32).toString('base64url');
  const verifier = randomBytes(32).toString('base64url');
  return JSON.stringify({ state, verifier });
}
function exactHttps(value: string) {
  const parsed = remoteEndpoint(value);
  if (parsed.href !== value) {
    throw new Error('OAuth configuration invalid');
  }
}
function requiredScopes(configuration: z.infer<typeof oauthConfigurationSchema>,
  policy: ReturnType<typeof toolPolicyFromRows>) {
  const required = new Set(configuration.protocolScopes);
  for (const tool of policy.tools) {
    if (tool.mode === 'block') {
      continue;
    }
    const declared = configuration.toolScopes[tool.name];
    if (!tool.reviewed || !declared) {
      throw new Error('OAuth configuration invalid');
    }
    for (const value of declared) {
      required.add(value);
    }
  }
  const result = [...required];
  result.sort();
  return scopes.parse(result);
}

/** Prepare custody only. The caller must supply trusted session context and loaded server history. */
export async function prepareOAuthAttempt(custody: Pick<ReturnType<typeof connectionCustody>,
  'prepareAttempt'>, rawContext: unknown, rawConfiguration: unknown, rows: StoredEvent[]) {
  try {
    const context = contextSchema.parse(rawContext);
    const configuration = oauthConfigurationSchema.parse(rawConfiguration);
    for (const value of [configuration.issuer, configuration.consentEndpoint,
      configuration.redirectUri]) {
      exactHttps(value);
    }
    const policy = toolPolicyFromRows(rows);
    const server = connectionServer(rows, context.connectionId);
    if (!server.available || Date.now() >= server.expiresAt || policy.silo !== context.siloId ||
        policy.serverId !== context.serverId || configuration.serverId !== context.serverId ||
        configuration.connectionId !== context.connectionId ||
        configuration.endpointDigest !== server.endpointDigest ||
        configuration.policyRevision !== policy.policyRevision) {
      return { status: 'unknown' as const };
    }
    const requestedScopes = requiredScopes(configuration, policy);
    // Keep the reference fixed when a retry changes its target profile or server.
    const subject = `connection-oauth-${context.userId}`;
    const operationId = connectionOperationId(context.siloId, subject, context.changeRef);
    const attemptDigest = digest(JSON.stringify([context, configuration, requestedScopes]));
    const stage = { siloId: context.siloId, userId: context.userId, serverId: context.serverId,
      connectionId: context.connectionId, profileId: context.profileId, purpose: 'personal' as const,
      generation: 1, endpointDigest: configuration.endpointDigest, operationId,
      expectedSequence: context.expectedSequence, attemptId: operationId, attemptDigest };
    const prepared = await custody.prepareAttempt(stage, privateMaterial);
    if (prepared.status !== 'prepared') {
      return { status: 'unknown' as const };
    }
    const material = privateSchema.parse(JSON.parse(prepared.contents));
    return { status: 'prepared' as const, stage: prepared.stage, identity: prepared.identity,
      stateDigest: digest(material.state), challenge: digest(material.verifier, 'base64url'),
      requestedScopes };
  } catch {
    // Hide validation and custody errors because their values can include private material.
    return { status: 'unknown' as const };
  }
}

/** Build the private browser handoff only after the caller confirms the saved start and access. */
export function oauthConsentUrl(configuration: z.infer<typeof oauthConfigurationSchema>,
  prepared: Extract<Awaited<ReturnType<typeof prepareOAuthAttempt>>, { status: 'prepared' }>,
  contents: string) {
  const material = privateSchema.parse(JSON.parse(contents));
  if (digest(material.state) !== prepared.stateDigest ||
      digest(material.verifier, 'base64url') !== prepared.challenge) {
    throw new Error('OAuth custody unavailable');
  }
  const url = new URL(configuration.consentEndpoint);
  const parameters = { response_type: 'code', client_id: configuration.clientId,
    redirect_uri: configuration.redirectUri, scope: prepared.requestedScopes.join(' '),
    state: material.state, code_challenge: prepared.challenge, code_challenge_method: 'S256' };
  url.search = new URLSearchParams(parameters).toString();
  return url.href;
}
