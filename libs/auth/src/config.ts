// Copied from OpenCrane 1 (10abd0ef6)
// libs/backend/server/infra/auth/src/configuration/oidc-config.ts; changed:
// dropped per-organisation clients, allowlists and the platform-operator
// bootstrap (none of that belongs in this slice), read the client secret
// through an env-var-name indirection instead of a direct value, and
// dropped the "OIDC not configured" development mode, since this slice
// always requires real OIDC settings.
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
    // Where the organisation and roles live in the ID token. Zitadel does not
    // use these defaults: its organisation is `urn:zitadel:iam:user:resourceowner:id`
    // and its roles are an object keyed by role name under
    // `urn:zitadel:iam:org:project:roles`. Set OIDC_ORG_CLAIM and
    // OIDC_ROLES_CLAIM to those names (and ask for the matching scopes in
    // OIDC_SCOPES) when pointing this at Zitadel.
    orgClaim: z.string().min(1),
    rolesClaim: z.string().min(1),
    // When set, only people from this organisation can sign in. A silo shares
    // one Zitadel with other silos, so a production start-up must set it
    // (loadAuthConfig refuses to start without OIDC_EXPECTED_ORG_ID). It is
    // optional here only so local development and tests can leave it out.
    expectedOrgId: z.string().min(1).optional(),
    stepUpMaxAgeSeconds: z.number().int().positive(),
    // Lets openid-client talk to a provider over plain http://. For local
    // development and tests only; a real deployment leaves it unset.
    allowInsecureRequests: z.boolean(),
  })
  .strict();

export type AuthConfig = z.infer<typeof configSchema>;

const REQUIRED_VARS = ['OIDC_ISSUER_URL', 'OIDC_CLIENT_ID', 'OIDC_REDIRECT_URI', 'OIDC_COOKIE_SECRET'] as const;

// Production also needs the organisation pin. Without it, anyone from any
// organisation on the shared Zitadel could sign in to this silo.
const PRODUCTION_ONLY_VARS = ['OIDC_EXPECTED_ORG_ID'] as const;

/**
 * Reads the OIDC login configuration from environment variables.
 *
 * The client secret is never read directly from an env var this function
 * names itself: `OIDC_CLIENT_SECRET_ENV_VAR` holds the NAME of another
 * variable that holds the actual secret, so the secret's value lives only
 * wherever the secret store injects it, never spelled out in this config.
 *
 * When `NODE_ENV` is `production`, `OIDC_EXPECTED_ORG_ID` is required too, so
 * a silo can only be started with sign-in pinned to its own organisation.
 */
export function loadAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  // Case and spaces are ignored on purpose: " Production " must not quietly
  // count as "not production" and skip the pin.
  const inProduction = env['NODE_ENV']?.trim().toLowerCase() === 'production';
  const required: readonly string[] = inProduction ? [...REQUIRED_VARS, ...PRODUCTION_ONLY_VARS] : REQUIRED_VARS;
  const missing = required.filter((name) => !env[name]?.trim());
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

  const clientSecretEnvVar = env['OIDC_CLIENT_SECRET_ENV_VAR']?.trim();
  const clientSecret = clientSecretEnvVar ? env[clientSecretEnvVar]?.trim() : undefined;
  if (clientSecretEnvVar && !clientSecret) {
    throw new Error(`OIDC_CLIENT_SECRET_ENV_VAR names ${clientSecretEnvVar}, which is not set`);
  }

  const postLogoutRedirectUri = env['OIDC_POST_LOGOUT_REDIRECT_URI']?.trim();
  const expectedOrgId = env['OIDC_EXPECTED_ORG_ID']?.trim();

  return configSchema.parse({
    issuerUrl: env['OIDC_ISSUER_URL']!.trim(),
    clientId: env['OIDC_CLIENT_ID']!.trim(),
    ...(clientSecret ? { clientSecret } : {}),
    redirectUri: env['OIDC_REDIRECT_URI']!.trim(),
    ...(postLogoutRedirectUri ? { postLogoutRedirectUri } : {}),
    scopes: env['OIDC_SCOPES']?.trim() || 'openid profile email',
    cookieSecret,
    cookieName: env['OIDC_COOKIE_NAME']?.trim() || 'oc_session',
    flowCookieName: env['OIDC_FLOW_COOKIE_NAME']?.trim() || 'oc_auth_flow',
    cookieSecure: readBoolean(env['OIDC_COOKIE_SECURE'], true, 'OIDC_COOKIE_SECURE'),
    sessionMaxAgeSeconds: readNumber(env['OIDC_SESSION_MAX_AGE_SECONDS'], 12 * 60 * 60),
    orgClaim: env['OIDC_ORG_CLAIM']?.trim() || 'org_id',
    rolesClaim: env['OIDC_ROLES_CLAIM']?.trim() || 'roles',
    ...(expectedOrgId ? { expectedOrgId } : {}),
    stepUpMaxAgeSeconds: readNumber(env['OIDC_STEP_UP_MAX_AGE_SECONDS'], 5 * 60),
    allowInsecureRequests: readBoolean(env['OIDC_ALLOW_INSECURE_REQUESTS'], false, 'OIDC_ALLOW_INSECURE_REQUESTS'),
  });
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
