// Copied from OpenCrane 1 (10abd0ef6); this package requires real OIDC settings.
import { z } from 'zod';

const configSchema = z
  .object({
    issuerUrl: z.string().url(),
    clientId: z.string().min(1),
    clientSecret: z.string().min(1).optional(),
    redirectUri: z.string().url(),
    postLogoutRedirectUri: z.string().url().optional(),
    scopes: z.string().min(1),
    cookieSecret: z.string().min(1),
    cookieName: z.string().min(1),
    flowCookieName: z.string().min(1),
    cookieSecure: z.boolean(),
    sessionMaxAgeSeconds: z.number().int().positive(),
    // These names locate the organisation and roles in the ID token. Zitadel
    // uses `urn:zitadel:iam:user:resourceowner:id` for the organisation and
    // `urn:zitadel:iam:org:project:roles` for roles. Set OIDC_ORG_CLAIM,
    // OIDC_ROLES_CLAIM and the matching OIDC_SCOPES when using Zitadel.
    orgClaim: z.string().min(1),
    rolesClaim: z.string().min(1),
    // When set, only people from this organisation can sign in. Production
    // silos share Zitadel, so OIDC_EXPECTED_ORG_ID is required there. Local
    // development and tests may leave it out.
    expectedOrgId: z.string().min(1).optional(),
    // Match token claims exactly. Reject whitespace that could be trimmed
    // from the configured value but not from the claim.
    extraIdentities: z.array(z.object({
      issuer: z.string().regex(/^\S+$/).url(),
      subject: z.string().regex(/^\S+$/),
    }).strict()),
    stepUpMaxAgeSeconds: z.number().int().positive(),
    // Lets openid-client talk to a provider over plain http://. For local
    // development and tests only; a real deployment leaves it unset.
    allowInsecureRequests: z.boolean(),
  })
  .strict();

export type AuthConfig = z.infer<typeof configSchema>;

const REQUIRED_VARS = ['OIDC_ISSUER_URL', 'OIDC_CLIENT_ID', 'OIDC_REDIRECT_URI', 'OIDC_COOKIE_SECRET'] as const;

// Require an organisation id in production. Otherwise any organisation on
// the shared Zitadel could sign in to this silo.
const PRODUCTION_ONLY_VARS = ['OIDC_EXPECTED_ORG_ID'] as const;

/**
 * Reads OIDC login settings from environment variables.
 *
 * `OIDC_CLIENT_SECRET_ENV_VAR` names the variable that contains the client
 * secret. This keeps the secret value in the secret store, not in this config.
 *
 * Production also requires `OIDC_EXPECTED_ORG_ID`, so sign-in is limited to
 * the silo's own organisation.
 */
export function loadAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  // Case and spaces are ignored on purpose: " Production " must not quietly
  // count as "not production" and skip the pin.
  const inProduction = text(env, 'NODE_ENV').toLowerCase() === 'production';
  const required: readonly string[] = inProduction ? [...REQUIRED_VARS, ...PRODUCTION_ONLY_VARS] : REQUIRED_VARS;
  const missing = required.filter((name) => !text(env, name));
  if (missing.length > 0) {
    const why = missing.includes('OIDC_EXPECTED_ORG_ID')
      ? '; OIDC_EXPECTED_ORG_ID is required when NODE_ENV=production so that only the organisation of this silo can sign in'
      : '';
    throw new Error(`missing required OIDC configuration: ${missing.join(', ')}${why}`);
  }

  const cookieSecret = env['OIDC_COOKIE_SECRET']!.trim();
  if (Buffer.byteLength(cookieSecret, 'utf8') < 32) {
    throw new Error('OIDC_COOKIE_SECRET must be at least 32 bytes');
  }

  const clientSecretEnvVar = text(env, 'OIDC_CLIENT_SECRET_ENV_VAR');
  const clientSecret = clientSecretEnvVar ? text(env, clientSecretEnvVar) : undefined;
  if (clientSecretEnvVar && !clientSecret) {
    throw new Error(`OIDC_CLIENT_SECRET_ENV_VAR names ${clientSecretEnvVar}, which is not set`);
  }

  const postLogoutRedirectUri = text(env, 'OIDC_POST_LOGOUT_REDIRECT_URI');
  const expectedOrgId = text(env, 'OIDC_EXPECTED_ORG_ID');
  const extraIdentities = readExtraIdentities(env['OIDC_EXTRA_IDENTITIES']);

  return configSchema.parse({
    ...readDefaults(env),
    issuerUrl: env['OIDC_ISSUER_URL']!.trim(),
    clientId: env['OIDC_CLIENT_ID']!.trim(),
    ...(clientSecret ? { clientSecret } : {}),
    redirectUri: env['OIDC_REDIRECT_URI']!.trim(),
    ...(postLogoutRedirectUri ? { postLogoutRedirectUri } : {}),
    cookieSecret,
    ...(expectedOrgId ? { expectedOrgId } : {}),
    extraIdentities,
  });
}

function readExtraIdentities(raw: string | undefined): unknown {
  if (!raw?.trim()) return [];
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('OIDC_EXTRA_IDENTITIES must be a JSON array of issuer and subject objects');
  }
}

/** Checks the organisation id, allowing exact issuer and subject exceptions. */
export function isIdentityAllowed(
  config: AuthConfig,
  identity: { issuer: string; subject: string; orgId: string },
): boolean {
  return config.expectedOrgId === undefined || identity.orgId === config.expectedOrgId
    || config.extraIdentities.some(({ issuer, subject }) => issuer === identity.issuer && subject === identity.subject);
}

const TRUE_VALUES = ['1', 'true', 'yes', 'on'];
const FALSE_VALUES = ['0', 'false', 'no', 'off'];

// An unset variable gets the default. A variable set to something we do not
// recognise ("flase") throws: reading it as false would quietly turn a
// security setting such as cookieSecure off.
function readBoolean(raw: string | undefined, fallback: boolean, varName: string): boolean {
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  const normalized = raw.trim().toLowerCase();
  if (TRUE_VALUES.includes(normalized)) return true;
  if (FALSE_VALUES.includes(normalized)) return false;
  throw new Error(`${varName} must be one of ${[...TRUE_VALUES, ...FALSE_VALUES].join(', ')} (got "${raw}")`);
}

function readNumber(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function text(env: NodeJS.ProcessEnv, name: string): string {
  return env[name]?.trim() ?? '';
}

function readDefaults(env: NodeJS.ProcessEnv) {
  return {
    scopes: text(env, 'OIDC_SCOPES') || 'openid profile email',
    cookieName: text(env, 'OIDC_COOKIE_NAME') || 'oc_session',
    flowCookieName: text(env, 'OIDC_FLOW_COOKIE_NAME') || 'oc_auth_flow',
    cookieSecure: readBoolean(env['OIDC_COOKIE_SECURE'], true, 'OIDC_COOKIE_SECURE'),
    sessionMaxAgeSeconds: readNumber(env['OIDC_SESSION_MAX_AGE_SECONDS'], 12 * 60 * 60),
    orgClaim: text(env, 'OIDC_ORG_CLAIM') || 'org_id',
    rolesClaim: text(env, 'OIDC_ROLES_CLAIM') || 'roles',
    stepUpMaxAgeSeconds: readNumber(env['OIDC_STEP_UP_MAX_AGE_SECONDS'], 5 * 60),
    allowInsecureRequests: readBoolean(env['OIDC_ALLOW_INSECURE_REQUESTS'], false, 'OIDC_ALLOW_INSECURE_REQUESTS'),
  };
}
