// Copied from OpenCrane 1 (10abd0ef6)
// libs/backend/server/infra/auth/src/login/oidc-service.ts and
// oidc-logout.ts; changed: dropped the Express `Request`-shaped API, the
// per-organisation client resolution (Kubernetes-backed, out of scope
// here), the UserInfo merge and the email allowlists — this is just the
// standards-only authorisation-code-with-PKCE exchange plus RP-initiated
// logout, built around the plain {@link AuthConfig} from ./config.ts.
import { URL } from 'node:url';
import * as client from 'openid-client';
import { isIdentityAllowed, type AuthConfig } from './config.ts';
import type { SessionData } from './session.ts';

/** Thrown when the identity provider rejects or cannot complete a login. */
export class OidcLoginError extends Error {}

// One discovered client configuration per AuthConfig instance. A server
// process builds its config once and keeps it for the process lifetime;
// tests that build several configs (e.g. one per mock provider) each get
// their own cache entry because the key is the object itself.
const discoveredByConfig = new WeakMap<AuthConfig, Promise<client.Configuration>>();

async function discover(config: AuthConfig): Promise<client.Configuration> {
  let discovering = discoveredByConfig.get(config);
  if (!discovering) {
    const clientAuth = config.clientSecret ? client.ClientSecretPost(config.clientSecret) : client.None();
    discovering = client.discovery(
      new URL(config.issuerUrl),
      config.clientId,
      undefined,
      clientAuth,
      config.allowInsecureRequests ? { execute: [client.allowInsecureRequests] } : undefined,
    );
    discoveredByConfig.set(config, discovering);
  }
  try {
    return await discovering;
  } catch (err) {
    // A transient discovery failure should not poison every later login.
    discoveredByConfig.delete(config);
    throw err;
  }
}

export interface LoginRedirect {
  /** Absolute provider URL to redirect the browser to. */
  url: string;
  state: string;
  nonce: string;
  codeVerifier: string;
}

/** Starts a login: picks PKCE/state/nonce values and builds the redirect URL. */
export async function buildLoginRedirect(config: AuthConfig): Promise<LoginRedirect> {
  const discovered = await discover(config);
  const codeVerifier = client.randomPKCECodeVerifier();
  const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
  const state = client.randomState();
  const nonce = client.randomNonce();
  const url = client.buildAuthorizationUrl(discovered, {
    redirect_uri: config.redirectUri,
    scope: config.scopes,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
    nonce,
  });
  return { url: url.href, state, nonce, codeVerifier };
}

// Roles arrive as a list of names, or (Zitadel) as an object whose keys are
// the role names. Anything else means no roles.
function readRoles(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.filter((role): role is string => typeof role === 'string');
  }
  if (typeof raw === 'object' && raw !== null) {
    return Object.keys(raw);
  }
  return [];
}

/** Finishes a login: exchanges the code and turns the ID-token claims into a {@link SessionData}. */
export async function completeLogin(
  config: AuthConfig,
  currentUrl: URL,
  flow: { state: string; nonce: string; codeVerifier: string },
): Promise<{ session: SessionData }> {
  const discovered = await discover(config);

  let tokens;
  try {
    tokens = await client.authorizationCodeGrant(discovered, currentUrl, {
      pkceCodeVerifier: flow.codeVerifier,
      expectedState: flow.state,
      expectedNonce: flow.nonce,
      idTokenExpected: true,
    });
  } catch (err) {
    throw new OidcLoginError('the identity provider rejected the login', { cause: err });
  }

  const claims = tokens.claims();
  if (!claims || typeof claims.sub !== 'string' || claims.sub === '') {
    throw new OidcLoginError('the identity provider returned no subject claim');
  }

  const orgId = claims[config.orgClaim];
  if (typeof orgId !== 'string' || orgId === '') {
    throw new OidcLoginError(`the identity provider returned no "${config.orgClaim}" claim`);
  }
  if (!isIdentityAllowed(config, { issuer: claims.iss, subject: claims.sub, orgId })) {
    // The reason is fixed text. It never says which organisation the person
    // belongs to, so the callback can show or log it without leaking that.
    throw new OidcLoginError('this account belongs to a different organisation');
  }

  // `auth_time` is when the person last really signed in. It is not "now":
  // a silent SSO login can finish this whole flow with nobody typing a
  // password. So a missing value becomes 0 (as old as it can be), and the
  // step-up check then says "not recent" instead of trusting the login.
  const authTime = typeof claims.auth_time === 'number' ? Math.floor(claims.auth_time) : 0;

  const roles = readRoles(claims[config.rolesClaim]);

  // The session cannot outlive the ID token, but it is also capped at the
  // deployment's configured maximum, whichever is sooner.
  const exp = Math.min(claims.exp, Math.floor(Date.now() / 1000) + config.sessionMaxAgeSeconds);

  return { session: { sub: claims.sub, orgId, roles, authTime, exp, ...(typeof claims['name'] === 'string' ? { name: claims['name'] } : {}), idToken: tokens.id_token! } };
}

/**
 * Builds the provider's RP-initiated-logout URL, or null when there is
 * nothing to redirect to (no `end_session_endpoint`, or discovery failed).
 * A provider problem must never block logging out of this server.
 */
export async function buildLogoutUrl(config: AuthConfig, idToken: string | undefined): Promise<string | null> {
  if (!idToken) return null;
  try {
    const discovered = await discover(config);
    if (!discovered.serverMetadata().end_session_endpoint) {
      return null;
    }
    // openid-client adds client_id itself. Zitadel needs it together with
    // post_logout_redirect_uri to send the person back to the app.
    const params: Record<string, string> = { id_token_hint: idToken };
    if (config.postLogoutRedirectUri) {
      params['post_logout_redirect_uri'] = config.postLogoutRedirectUri;
    }
    return client.buildEndSessionUrl(discovered, params).href;
  } catch {
    return null;
  }
}
