// These tests run the real openid-client against a small local OIDC
// provider, so a change to the login code shows up as a failing test.
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { loadAuthConfig, type AuthConfig } from '../src/config.ts';
import { buildLoginRedirect, buildLogoutUrl, completeLogin, OidcLoginError } from '../src/oidc-client.ts';
import { hasRecentAuth } from '../src/session.ts';
import { testAuthConfig } from './fixtures.ts';
import { DEFAULT_MOCK_USER, MOCK_ID_TOKEN_LIFETIME_SECONDS, startMockOidcProvider, type MockOidcOptions, type MockOidcProvider, type MockUser } from './mock-oidc-provider.ts';

const providers: MockOidcProvider[] = [];

afterEach(async () => {
  await Promise.all(providers.splice(0).map((provider) => provider.close()));
});

async function setup(options: MockOidcOptions = {}, overrides: Partial<AuthConfig> = {}) {
  const provider = await startMockOidcProvider(options);
  providers.push(provider);
  const config = testAuthConfig({ issuerUrl: provider.url, clientId: provider.clientId, allowInsecureRequests: true, ...overrides });
  return { provider, config };
}

// Walks the login as a browser would, minus the screens: start the login,
// let the provider send the browser back to the callback, and return both.
async function startAndReturn(config: AuthConfig) {
  const flow = await buildLoginRedirect(config);
  const response = await fetch(flow.url, { redirect: 'manual' });
  return { flow, callback: new URL(response.headers.get('location')!) };
}

async function signIn(config: AuthConfig) {
  const { flow, callback } = await startAndReturn(config);
  return (await completeLogin(config, callback, flow)).session;
}

async function expectLoginRejected(attempt: Promise<unknown>, message: string) {
  const error = await attempt.then(() => undefined, (err: unknown) => err);
  expect(error).toBeInstanceOf(OidcLoginError);
  expect((error as OidcLoginError).message).toContain(message);
}

const nowSeconds = () => Math.floor(Date.now() / 1000);
const member: MockUser = { sub: 'user-1', orgId: 'org-1', roles: ['member'] };

describe('buildLoginRedirect', () => {
  it('asks the provider for PKCE (S256), state and a nonce', async () => {
    const { provider, config } = await setup();
    const redirect = await buildLoginRedirect(config);
    const url = new URL(redirect.url);
    const params = url.searchParams;

    expect(url.origin + url.pathname).toBe(`${provider.url}/authorize`);
    expect(params.get('response_type')).toBe('code');
    expect(params.get('client_id')).toBe(provider.clientId);
    expect(params.get('redirect_uri')).toBe(config.redirectUri);
    expect(params.get('scope')).toBe(config.scopes);
    expect(params.get('code_challenge_method')).toBe('S256');
    expect(params.get('code_challenge')).toBe(createHash('sha256').update(redirect.codeVerifier).digest('base64url'));
    expect(params.get('state')).toBe(redirect.state);
    expect(params.get('nonce')).toBe(redirect.nonce);
  });

  it('does not keep a failed discovery: the next login works once the provider recovers', async () => {
    const { config } = await setup({ failDiscovery: 1 });
    await expect(buildLoginRedirect(config)).rejects.toThrow();
    const redirect = await buildLoginRedirect(config);
    expect(redirect.url).toContain('/authorize');
  });
});

describe('completeLogin: who signed in', () => {
  it('builds the session from the ID token, using the provider auth_time', async () => {
    const { config } = await setup();
    const session = await signIn(config);

    // The default user signed in an hour ago, so "now" would give a different number.
    expect(session).toMatchObject({ sub: 'user-1', orgId: 'org-1', roles: ['member'], authTime: DEFAULT_MOCK_USER.authTime });
  });

  it('rejects an empty subject', async () => {
    const { config } = await setup({ user: { ...member, sub: '' } });
    await expectLoginRejected(signIn(config), 'no subject claim');
  });

  it.each([undefined, ''])('rejects an ID token whose organisation claim is %j', async (orgId) => {
    const user: MockUser = orgId === undefined ? { sub: 'user-1', roles: [] } : { ...member, orgId };
    const { config } = await setup({ user });
    await expectLoginRejected(signIn(config), 'no "org_id" claim');
  });

  it('only lets in the expected organisation', async () => {
    const wrong = await setup({}, { expectedOrgId: 'org-2' });
    await expectLoginRejected(signIn(wrong.config), 'different organisation');

    const right = await setup({}, { expectedOrgId: 'org-1' });
    expect((await signIn(right.config)).orgId).toBe('org-1');
  });
});

describe('completeLogin: sign-in pinned to the silo organisation', () => {
  // Builds the config the way a production start-up does, from environment
  // variables, so the pin is proved from the env var all the way to the callback.
  async function productionSetup(expectedOrgId: string) {
    const provider = await startMockOidcProvider();
    providers.push(provider);
    return loadAuthConfig({
      NODE_ENV: 'production',
      OIDC_ISSUER_URL: provider.url,
      OIDC_CLIENT_ID: provider.clientId,
      OIDC_REDIRECT_URI: 'https://app.example.test/auth/callback',
      OIDC_COOKIE_SECRET: 'a'.repeat(32),
      OIDC_EXPECTED_ORG_ID: expectedOrgId,
      OIDC_ALLOW_INSECURE_REQUESTS: 'true', // the mock provider speaks plain http
    });
  }

  it('refuses a person from another organisation with a fixed reason and no session', async () => {
    const config = await productionSetup('org-2'); // the mock person belongs to org-1
    const { flow, callback } = await startAndReturn(config);

    const error = await completeLogin(config, callback, flow).then(() => undefined, (err: unknown) => err);

    expect(error).toBeInstanceOf(OidcLoginError);
    // The reason never names either organisation, so it is safe to show or log.
    expect((error as OidcLoginError).message).toBe('this account belongs to a different organisation');
    expect((error as OidcLoginError).cause).toBeUndefined();
  });

  it('lets in a person from the pinned organisation', async () => {
    const config = await productionSetup('org-1');
    expect(await signIn(config)).toMatchObject({ sub: 'user-1', orgId: 'org-1' });
  });

  it('does not decide on the organisation alone: a missing organisation claim is refused too', async () => {
    const provider = await startMockOidcProvider({ user: { sub: 'user-1', roles: [] } });
    providers.push(provider);
    const config = testAuthConfig({ issuerUrl: provider.url, clientId: provider.clientId, allowInsecureRequests: true, expectedOrgId: 'org-1' });
    await expectLoginRejected(signIn(config), 'no "org_id" claim');
  });
});

describe('completeLogin: claim shapes', () => {
  it('reads the Zitadel organisation claim and its roles object (the keys are the roles)', async () => {
    const orgClaim = 'urn:zitadel:iam:user:resourceowner:id';
    const rolesClaim = 'urn:zitadel:iam:org:project:roles';
    const grant = { '300': 'acme.idp.example.test' };
    const user: MockUser = { sub: 'user-1', roles: [], claims: { [orgClaim]: 'org-77', [rolesClaim]: { admin: grant, member: grant } } };
    const { config } = await setup({ user }, { orgClaim, rolesClaim });

    expect(await signIn(config)).toMatchObject({ orgId: 'org-77', roles: ['admin', 'member'] });
  });

  it.each([
    ['a list with something that is not a name in it', ['admin', 7, null], ['admin']],
    ['a plain string', 'admin', []],
    ['null', null, []],
  ])('reads %s as the roles claim', async (_label, roles, expected) => {
    const { config } = await setup({ user: { ...member, claims: { roles } } });
    expect((await signIn(config)).roles).toEqual(expected);
  });
});

describe('completeLogin: step-up time', () => {
  it('turns a missing auth_time into 0, so the step-up check refuses (no fail-open)', async () => {
    const { config } = await setup({ user: member });
    const session = await signIn(config);

    expect(session.authTime).toBe(0);
    expect(hasRecentAuth(config, session)).toBe(false);
  });

  it('keeps a real auth_time, so a fresh sign-in passes the step-up check and an old one does not', async () => {
    const thirtySecondsAgo = nowSeconds() - 30;
    const fresh = await setup({ user: { ...member, authTime: thirtySecondsAgo + 0.6 } });
    const session = await signIn(fresh.config);
    expect(session.authTime).toBe(thirtySecondsAgo); // whole seconds, as the session schema needs
    expect(hasRecentAuth(fresh.config, session)).toBe(true);

    const old = await setup({ user: { ...member, authTime: nowSeconds() - 3600 } });
    expect(hasRecentAuth(old.config, await signIn(old.config))).toBe(false);
  });

});

describe('completeLogin: session expiry', () => {
  it('never outlives the ID token', async () => {
    const { config } = await setup();
    const before = nowSeconds();
    const { exp } = await signIn(config);

    expect(exp).toBeGreaterThanOrEqual(before + MOCK_ID_TOKEN_LIFETIME_SECONDS);
    expect(exp).toBeLessThanOrEqual(nowSeconds() + MOCK_ID_TOKEN_LIFETIME_SECONDS);
  });

  it('never outlives sessionMaxAgeSeconds either', async () => {
    const { config } = await setup({}, { sessionMaxAgeSeconds: 60 });
    const before = nowSeconds();
    const { exp } = await signIn(config);

    expect(exp).toBeGreaterThanOrEqual(before + 60);
    expect(exp).toBeLessThanOrEqual(nowSeconds() + 60);
  });
});

describe('completeLogin: attacks and failures', () => {
  it('rejects a callback whose state is not the one this browser started with', async () => {
    const { provider, config } = await setup();
    const { flow, callback } = await startAndReturn(config);

    await expectLoginRejected(completeLogin(config, callback, { ...flow, state: 'a-different-state' }), 'rejected the login');
    expect(provider.tokenRequests()).toHaveLength(0);
  });

  it('rejects a callback that carries no state at all', async () => {
    const { config } = await setup();
    const { flow, callback } = await startAndReturn(config);
    callback.searchParams.delete('state');

    await expectLoginRejected(completeLogin(config, callback, flow), 'rejected the login');
  });

  it('rejects an ID token that was issued for a different nonce', async () => {
    const { config } = await setup();
    const { flow, callback } = await startAndReturn(config);

    await expectLoginRejected(completeLogin(config, callback, { ...flow, nonce: 'a-different-nonce' }), 'rejected the login');
  });

  it('rejects a code exchange that uses the wrong PKCE verifier, and keeps the cause', async () => {
    const { config } = await setup();
    const { flow, callback } = await startAndReturn(config);
    const attempt = completeLogin(config, callback, { ...flow, codeVerifier: 'a'.repeat(43) });

    await expectLoginRejected(attempt, 'rejected the login');
    await expect(attempt).rejects.toHaveProperty('cause');
  });
});

describe('completeLogin: client authentication', () => {
  it('sends the client secret to the token endpoint when one is configured', async () => {
    const { provider, config } = await setup({ clientSecret: 's3cret' }, { clientSecret: 's3cret' });
    await signIn(config);

    expect(provider.tokenRequests()[0]).toMatchObject({ client_id: provider.clientId, client_secret: 's3cret' });
  });
});

describe('buildLogoutUrl', () => {
  it('points at the provider logout with client_id and the post-logout redirect', async () => {
    const postLogoutRedirectUri = 'https://app.example.test/signed-out';
    const { provider, config } = await setup({}, { postLogoutRedirectUri });
    const url = new URL((await buildLogoutUrl(config))!);

    expect(url.origin + url.pathname).toBe(`${provider.url}/endsession`);
    expect(url.searchParams.get('client_id')).toBe(provider.clientId);
    expect(url.searchParams.get('post_logout_redirect_uri')).toBe(postLogoutRedirectUri);
  });

  it('leaves post_logout_redirect_uri out when none is configured', async () => {
    const { config } = await setup();
    const url = new URL((await buildLogoutUrl(config))!);

    expect(url.searchParams.has('post_logout_redirect_uri')).toBe(false);
  });

  it('is null when the provider has no end_session_endpoint', async () => {
    const { config } = await setup({ endSession: false });
    expect(await buildLogoutUrl(config)).toBeNull();
  });

  it('is null, not an error, when the provider cannot be reached', async () => {
    const { provider, config } = await setup();
    await provider.close();

    expect(await buildLogoutUrl(config)).toBeNull();
  });
});
