// Copied from OpenCrane 1 (10abd0ef6); this package uses PKCE login and provider logout.
import { URL } from 'node:url';
import * as client from 'openid-client';
import { isIdentityAllowed, type AuthConfig } from './config.ts';
import type { SessionData } from './session.ts';

/** Thrown when the identity provider rejects or cannot complete a login. */
export class OidcLoginError extends Error {}

// Keep one discovered client configuration for each AuthConfig object. A
// server reuses its config, while tests with different providers stay separate.
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
export async function buildLoginRedirect(config: AuthConfig, stepUp = false): Promise<LoginRedirect> {
  const discovered = await discover(config);
  const codeVerifier = client.randomPKCECodeVerifier();
  const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
  const state = client.randomState();
  const nonce = client.randomNonce();
  const url = client.buildAuthorizationUrl(discovered, {
    ...(stepUp ? { max_age: '0', prompt: 'login' } : {}),
    redirect_uri: config.redirectUri,
    scope: config.scopes,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
    nonce,
  });
  return { url: url.href, state, nonce, codeVerifier };
}

// Roles may be a list of names or, with Zitadel, an object keyed by role name.
// Treat every other shape as having no roles.
function readRoles(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.filter((role): role is string => typeof role === 'string');
  }
  if (typeof raw === 'object' && raw !== null) {
    return Object.keys(raw);
  }
  return [];
}

/** Finishes login by exchanging the code and reading the ID-token claims. */
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

  // `auth_time` records when the person last signed in, not when this flow
  // ended. Silent SSO may need no password. Treat a missing value as 0 so a
  // step-up check will not mistake this login for a recent sign-in.
  const authTime = typeof claims.auth_time === 'number' ? Math.floor(claims.auth_time) : 0;

  const roles = readRoles(claims[config.rolesClaim]);

  // Expire the session when the ID token expires or the configured limit is
  // reached, whichever comes first.
  const exp = Math.min(claims.exp, Math.floor(Date.now() / 1000) + config.sessionMaxAgeSeconds);

  const session: SessionData = {
    sub: claims.sub, orgId, roles, authTime, exp,
    emailVerified: claims['email_verified'] === true,
    idToken: tokens.id_token!,
  };
  if (typeof claims['email'] === 'string') {
    session.email = claims['email'];
  }
  if (typeof claims['name'] === 'string') {
    session.name = claims['name'];
  }
  return { session };
}

/**
 * Builds the provider logout URL, or returns null when discovery gives no
 * logout endpoint. A provider problem must not block logout from this server.
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
