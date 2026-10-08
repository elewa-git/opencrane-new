import assert from 'node:assert/strict';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { decodeSession, encodeSession, type AuthConfig } from '@opencrane/auth';
import { buildServer } from '../src/server.ts';
import { DEFAULT_MOCK_USER, startMockOidcProvider, type MockOidcProvider } from './support/mock-oidc-provider.ts';
import { replaceInCiphertext, tamperCookie, testAuthConfig, truncateAuthTag } from './support/test-auth-config.ts';

type Response = Awaited<ReturnType<FastifyInstance['inject']>>;
type MockProviderOptions = Parameters<typeof startMockOidcProvider>[0];

interface Stack {
  provider: MockOidcProvider;
  app: FastifyInstance;
  config: AuthConfig;
}

const stacks: Stack[] = [];

afterEach(async () => {
  for (const stack of stacks.splice(0)) {
    await stack.app.close();
    await stack.provider.close();
  }
});

/** A server wired to its own mock provider on 127.0.0.1. Closed after each test. */
async function startStack(providerOptions: MockProviderOptions = {}, overrides: Partial<AuthConfig> = {}): Promise<Stack> {
  const provider = await startMockOidcProvider(providerOptions);
  const config = testAuthConfig({
    issuerUrl: provider.url,
    clientId: provider.clientId,
    redirectUri: 'http://app.example.test/auth/callback',
    cookieSecure: false,
    sessionMaxAgeSeconds: 3600,
    expectedOrgId: 'org-1',
    // Our own loopback mock, never a real deployment's issuer.
    allowInsecureRequests: true,
    ...overrides,
  });
  const stack = { provider, app: buildServer(config), config };
  stacks.push(stack);
  return stack;
}

/** One cookie from a response, parsed by light-my-request (so attributes are checked as sent). */
function findCookie(response: Response, name: string) {
  const cookie = response.cookies.find((entry) => entry.name === name);
  if (!cookie) {
    throw new Error(`expected a ${name} cookie in the response`);
  }
  return cookie;
}

function cookieValue(response: Response, name: string): string {
  return findCookie(response, name).value;
}

/** HttpOnly and SameSite=Lax always; Secure exactly when `secure` is true. */
function expectCookieAttributes(response: Response, name: string, secure: boolean): void {
  const cookie = findCookie(response, name);
  expect(cookie.httpOnly).toBe(true);
  expect(cookie.sameSite).toBe('Lax');
  // The parser leaves `secure` out entirely when the attribute is absent.
  expect(Boolean(cookie.secure)).toBe(secure);
}

/** Runs /auth/login and the provider's authorize step, stopping at the callback. */
async function startLogin(stack: Stack, returnTo?: string) {
  const url = returnTo === undefined ? '/auth/login' : `/auth/login?returnTo=${encodeURIComponent(returnTo)}`;
  const login = await stack.app.inject({ method: 'GET', url });
  expect(login.statusCode).toBe(302);
  const flowCookie = cookieValue(login, stack.config.flowCookieName);
  // The provider is a real loopback server that app.inject cannot reach, so
  // the test makes this one request itself, as the browser would.
  assert(typeof login.headers.location === 'string');
  const authorize = await fetch(login.headers.location, { redirect: 'manual' });
  const callbackUrl = new URL(authorize.headers.get('location')!);
  return { login, flowCookie, callbackQuery: `${callbackUrl.pathname}${callbackUrl.search}` };
}

/** A full login: returns the callback response. */
async function signIn(stack: Stack, returnTo?: string): Promise<Response> {
  const { flowCookie, callbackQuery } = await startLogin(stack, returnTo);
  return stack.app.inject({ method: 'GET', url: callbackQuery, cookies: { [stack.config.flowCookieName]: flowCookie } });
}

async function whoAmI(stack: Stack, sessionCookie: string) {
  const response = await stack.app.inject({ method: 'GET', url: '/auth/me', cookies: { [stack.config.cookieName]: sessionCookie } });
  return response.json<{ authenticated: boolean; user: { sub: string; orgId: string; roles: string[]; authTime: number; exp: number } | null }>();
}

const NOT_SIGNED_IN = { authenticated: false, user: null };

describe('OIDC login flow (against a local mock provider)', () => {
  it('completes login, reports the caller on /auth/me, then logs out', async () => {
    const stack = await startStack({ user: { ...DEFAULT_MOCK_USER, claims: { name: 'Alex Morgan' } } });
    const { login, flowCookie, callbackQuery } = await startLogin(stack);
    expectCookieAttributes(login, stack.config.flowCookieName, false);

    const callback = await stack.app.inject({ method: 'GET', url: callbackQuery, cookies: { [stack.config.flowCookieName]: flowCookie } });
    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toBe('/');
    expectCookieAttributes(callback, stack.config.cookieName, false);
    // The spent flow cookie is cleared, not left to time out.
    const clearedFlow = findCookie(callback, stack.config.flowCookieName);
    expect(clearedFlow.value).toBe('');
    expect(clearedFlow.maxAge).toBe(0);

    const sessionCookie = cookieValue(callback, stack.config.cookieName);
    const me = await whoAmI(stack, sessionCookie);
    expect(me.authenticated).toBe(true);
    expect(me.user).not.toHaveProperty('idToken');
    expect(decodeSession(stack.config, sessionCookie).idToken).toBeTruthy();
    expect(me.user).toMatchObject({ sub: 'user-1', orgId: 'org-1', roles: ['member'], name: 'Alex Morgan' });
    // The provider's own auth_time, not the moment the callback ran.
    expect(me.user?.authTime).toBe(DEFAULT_MOCK_USER.authTime);

    const logout = await stack.app.inject({ method: 'POST', url: '/auth/logout', headers: { origin: 'http://app.example.test' }, cookies: { [stack.config.cookieName]: sessionCookie } });
    expect(logout.statusCode).toBe(303);
    expect(logout.body).toBe('');
    expect(logout.headers.location).toContain(`${stack.provider.url}/endsession`);
    expect(findCookie(logout, stack.config.cookieName)).toMatchObject({ value: '', maxAge: 0 });
    expect((await stack.app.inject({ method: 'GET', url: '/auth/me' })).json()).toEqual(NOT_SIGNED_IN);
  });

  it('sets Secure on the flow cookie and the session cookie when cookieSecure is true', async () => {
    const stack = await startStack({}, { cookieSecure: true });
    const { login, flowCookie, callbackQuery } = await startLogin(stack);
    expectCookieAttributes(login, stack.config.flowCookieName, true);
    const callback = await stack.app.inject({ method: 'GET', url: callbackQuery, cookies: { [stack.config.flowCookieName]: flowCookie } });
    expectCookieAttributes(callback, stack.config.cookieName, true);
    // Clearing a cookie keeps the same attributes, or a browser may ignore it.
    expectCookieAttributes(callback, stack.config.flowCookieName, true);
  });

  it('never lets the session outlive the ID token, whatever sessionMaxAgeSeconds says', async () => {
    // The mock's ID token lasts 300 seconds; the configured maximum is one hour.
    const stack = await startStack({}, { sessionMaxAgeSeconds: 3600 });
    const me = await whoAmI(stack, cookieValue(await signIn(stack), stack.config.cookieName));
    const nowSeconds = Math.floor(Date.now() / 1000);
    expect(me.user!.exp).toBeLessThanOrEqual(nowSeconds + 300);
    expect(me.user!.exp).toBeGreaterThan(nowSeconds);
  });

  it('caps the session at sessionMaxAgeSeconds when that is shorter than the ID token', async () => {
    const stack = await startStack({}, { sessionMaxAgeSeconds: 60 });
    const me = await whoAmI(stack, cookieValue(await signIn(stack), stack.config.cookieName));
    expect(me.user!.exp).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 60);
  });

  it('rejects a callback whose state does not match the login that started it', async () => {
    const stack = await startStack();
    const { flowCookie, callbackQuery } = await startLogin(stack);
    const wrongState = callbackQuery.replace(/state=[^&]+/, 'state=not-the-real-state');
    const callback = await stack.app.inject({ method: 'GET', url: wrongState, cookies: { [stack.config.flowCookieName]: flowCookie } });
    expect(callback.statusCode).toBe(400);
  });

  it('rejects a callback with no login-flow cookie at all', async () => {
    const stack = await startStack();
    const { callbackQuery } = await startLogin(stack);
    expect((await stack.app.inject({ method: 'GET', url: callbackQuery })).statusCode).toBe(400);
  });

  describe('a session cookie that is not genuine is treated as signed out', () => {
    it('tampered (first ciphertext byte changed)', async () => {
      const stack = await startStack();
      const sessionCookie = cookieValue(await signIn(stack), stack.config.cookieName);
      expect(await whoAmI(stack, tamperCookie(sessionCookie))).toEqual(NOT_SIGNED_IN);
    });

    it('expired', async () => {
      const stack = await startStack();
      const nowSeconds = Math.floor(Date.now() / 1000);
      const expired = encodeSession(stack.config, { idToken: 'test-id-token', sub: 'user-1', orgId: 'org-1', roles: ['member'], authTime: nowSeconds - 7200, exp: nowSeconds - 1 });
      expect(await whoAmI(stack, expired)).toEqual(NOT_SIGNED_IN);
    });

    it('with the authentication tag cut down to 4 bytes', async () => {
      const stack = await startStack();
      const sessionCookie = cookieValue(await signIn(stack), stack.config.cookieName);
      expect(await whoAmI(stack, truncateAuthTag(sessionCookie, 4))).toEqual(NOT_SIGNED_IN);
    });

    it('forged from a real cookie to say org-2 (still valid JSON, so only the tag can catch it)', async () => {
      const stack = await startStack();
      const session = { sub: 'user-1', orgId: 'org-1', roles: ['member'], authTime: 1_700_000_000, exp: Math.floor(Date.now() / 1000) + 600 };
      const real = encodeSession(stack.config, session);
      expect((await whoAmI(stack, real)).user?.orgId).toBe('org-1');
      const forged = replaceInCiphertext(real, JSON.stringify(session), '"org-1"', '"org-2"');
      expect(await whoAmI(stack, forged)).toEqual(NOT_SIGNED_IN);
    });
  });

  it('sends browser callback failures to the rejected screen and clears both cookies', async () => {
    const stack = await startStack();
    const reply = await stack.app.inject({ method: 'GET', url: '/auth/callback?error=access_denied', headers: { accept: 'text/html' } });
    expect(reply.statusCode).toBe(302);
    expect(reply.headers.location).toBe('/signin/rejected?reason=rejected');
    expect(findCookie(reply, stack.config.cookieName)).toMatchObject({ value: '', maxAge: 0 });
    expect(findCookie(reply, stack.config.flowCookieName)).toMatchObject({ value: '', maxAge: 0 });
  });

  it('refuses an existing session after the configured organisation pin changes', async () => {
    const stack = await startStack({}, { expectedOrgId: 'org-2' });
    const now = Math.floor(Date.now() / 1000);
    const cookie = encodeSession(stack.config, { sub: 'user-1', orgId: 'org-1', roles: [], authTime: now, exp: now + 300 });
    expect(await whoAmI(stack, cookie)).toEqual(NOT_SIGNED_IN);
  });

  async function refusesSessionWithoutOrganisation(): Promise<void> {
    const stack = await startStack();
    delete stack.config.expectedOrgId;
    const callback = await signIn(stack);
    expect(callback.statusCode).toBe(302);
    const cookie = cookieValue(callback, stack.config.cookieName);
    expect(await whoAmI(stack, cookie)).toEqual(NOT_SIGNED_IN);
  }

  async function refusesLogoutWithoutOrganisation(): Promise<void> {
    const stack = await startStack();
    delete stack.config.expectedOrgId;
    const callback = await signIn(stack);
    const cookie = cookieValue(callback, stack.config.cookieName);
    const request = {
      method: 'POST' as const,
      url: '/auth/logout',
      headers: { origin: 'http://app.example.test' },
      cookies: { [stack.config.cookieName]: cookie },
    };
    const response = await stack.app.inject(request);
    expect(response.statusCode).toBe(403);
    expect(response.headers['set-cookie']).toBeUndefined();
  }

  it('allows development sign-in but refuses session routes without an organisation',
    refusesSessionWithoutOrganisation);
  it('refuses logout without an organisation and keeps the session cookie',
    refusesLogoutWithoutOrganisation);

  describe('returnTo after login', () => {
    it('keeps a genuine same-site path', async () => {
      const stack = await startStack();
      expect((await signIn(stack, '/dashboard?tab=2')).headers.location).toBe('/dashboard?tab=2');
    });

    // Each of these would send a browser to evil.example if the redirect kept it.
    it.each([
      ['a backslash', '/\\evil.example/phish'],
      ['a tab', '/\t/evil.example'],
      ['a dot-segment', '/.//evil.example'],
      ['a protocol-relative URL', '//evil.example'],
      ['an absolute URL', 'https://evil.example/phish'],
    ])('does not redirect to another site through %s', async (_name, returnTo) => {
      const stack = await startStack();
      expect((await signIn(stack, returnTo)).headers.location).toBe('/');
    });
  });

  describe('claims in the ID token', () => {
    it('rejects a login whose ID token has no organisation claim', async () => {
      const stack = await startStack({ user: { sub: 'user-1', roles: ['member'], authTime: 1_700_000_000 } });
      const callback = await signIn(stack);
      expect(callback.statusCode).toBe(400);
      expect(findCookie(callback, stack.config.cookieName)).toMatchObject({ value: '', maxAge: 0 });
    });

    it('rejects a login from another organisation when expectedOrgId is set', async () => {
      const stack = await startStack({}, { expectedOrgId: 'org-2' });
      const callback = await signIn(stack);
      expect(callback.statusCode).toBe(400);
      expect(findCookie(callback, stack.config.cookieName)).toMatchObject({ value: '', maxAge: 0 });
    });

    it('accepts a login from the expected organisation', async () => {
      const stack = await startStack({}, { expectedOrgId: 'org-1' });
      expect((await signIn(stack)).statusCode).toBe(302);
    });

    it('keeps an allowlisted cross-organisation session active on server routes', async () => {
      const stack = await startStack({}, { expectedOrgId: 'org-2' });
      stack.config.extraIdentities.push({ issuer: stack.provider.url, subject: 'user-1' });
      const callback = await signIn(stack);
      expect(callback.statusCode).toBe(302);
      const sessionCookie = cookieValue(callback, stack.config.cookieName);
      expect((await whoAmI(stack, sessionCookie)).authenticated).toBe(true);
      expect((await stack.app.inject({ method: 'POST', url: '/auth/logout', headers: { origin: 'http://app.example.test' },
        cookies: { [stack.config.cookieName]: sessionCookie } })).statusCode).toBe(303);
    });

    it('records auth_time 0 when the ID token has none, so step-up never counts it as recent', async () => {
      // If a missing auth_time fell back to "now", a silent SSO login would
      // look freshly authenticated.
      const stack = await startStack({ user: { sub: 'user-1', orgId: 'org-1', roles: ['member'] } });
      const me = await whoAmI(stack, cookieValue(await signIn(stack), stack.config.cookieName));
      expect(me.user?.authTime).toBe(0);
    });

    it('reads Zitadel-style claims: a resource-owner id and roles as an object keyed by role name', async () => {
      const orgClaim = 'urn:zitadel:iam:user:resourceowner:id';
      const rolesClaim = 'urn:zitadel:iam:org:project:roles';
      const stack = await startStack(
        { user: { sub: 'user-1', roles: [], authTime: 1_700_000_000, claims: { [orgClaim]: 'org-7', [rolesClaim]: { admin: { 'org-7': 'acme.example' }, member: { 'org-7': 'acme.example' } } } } },
        { orgClaim, rolesClaim, expectedOrgId: 'org-7' },
      );
      const me = await whoAmI(stack, cookieValue(await signIn(stack), stack.config.cookieName));
      expect(me.user).toMatchObject({ orgId: 'org-7', roles: ['admin', 'member'] });
    });
  });

  describe('client authentication at the token endpoint', () => {
    it('sends client_id and redirect_uri, and no secret for a public client', async () => {
      const stack = await startStack();
      await signIn(stack);
      const [request] = stack.provider.tokenRequests();
      expect(request).toMatchObject({ client_id: stack.provider.clientId, redirect_uri: stack.config.redirectUri, grant_type: 'authorization_code' });
      expect(request?.['client_secret']).toBeUndefined();
    });

    it('sends the client secret when one is configured', async () => {
      const stack = await startStack({ clientSecret: 's3cret-value' }, { clientSecret: 's3cret-value' });
      expect((await signIn(stack)).statusCode).toBe(302);
      expect(stack.provider.tokenRequests()[0]?.['client_secret']).toBe('s3cret-value');
    });

    it('fails the login when the configured client secret is wrong', async () => {
      const stack = await startStack({ clientSecret: 's3cret-value' }, { clientSecret: 'not-the-secret' });
      expect((await signIn(stack)).statusCode).toBe(400);
    });

    it('fails the login when the provider expects a secret and none is configured', async () => {
      const stack = await startStack({ clientSecret: 's3cret-value' });
      expect((await signIn(stack)).statusCode).toBe(400);
    });
  });

  describe('logout', () => {
    it.each([undefined, 'https://attacker.example', 'http://app.example.test.evil', 'null'])(
      'refuses origin %s without clearing the session or flow', async (origin) => {
        const stack = await startStack();
        const sessionCookie = cookieValue(await signIn(stack), stack.config.cookieName);
        const response = await stack.app.inject({ method: 'POST', url: '/auth/logout',
          headers: origin === undefined ? {} : { origin }, cookies: { [stack.config.cookieName]: sessionCookie } });
        expect(response.statusCode).toBe(403);
        expect(response.headers['set-cookie']).toBeUndefined();
        expect((await whoAmI(stack, sessionCookie)).authenticated).toBe(true);
      });

    it.each(['missing', 'invalid', 'expired', 'wrong organisation'])(
      'refuses a %s session without clearing cookies', async (kind) => {
        const stack = await startStack({}, { expectedOrgId: 'org-1' });
        const now = Math.floor(Date.now() / 1000);
        const value = kind === 'invalid' ? 'invalid' : encodeSession(stack.config, {
          sub: 'user-1', orgId: kind === 'wrong organisation' ? 'org-2' : 'org-1', roles: [],
          authTime: now, exp: kind === 'expired' ? now - 1 : now + 300,
        });
        const response = await stack.app.inject({ method: 'POST', url: '/auth/logout',
          headers: { origin: 'http://app.example.test' },
          cookies: kind === 'missing' ? {} : { [stack.config.cookieName]: value } });
        expect(response.statusCode).toBe(kind === 'wrong organisation' ? 403 : 401);
        expect(response.headers['set-cookie']).toBeUndefined();
      });

    it('asks the provider to send the person back to postLogoutRedirectUri, naming the client', async () => {
      const stack = await startStack({}, { postLogoutRedirectUri: 'http://app.example.test/signed-out' });
      const sessionCookie = cookieValue(await signIn(stack), stack.config.cookieName);
      const logout = await stack.app.inject({ method: 'POST', url: '/auth/logout', headers: { origin: 'http://app.example.test' }, cookies: { [stack.config.cookieName]: sessionCookie } });
      const endSession = new URL(String(logout.headers.location));
      expect(endSession.origin + endSession.pathname).toBe(`${stack.provider.url}/endsession`);
      expect(endSession.searchParams.get('post_logout_redirect_uri')).toBe('http://app.example.test/signed-out');
      expect(endSession.searchParams.get('client_id')).toBe(stack.provider.clientId);
      expect(endSession.searchParams.get('id_token_hint') === decodeSession(stack.config, sessionCookie).idToken).toBe(true);
      expect(logout.statusCode).toBe(303);
      expect(logout.body).toBe('');
      expect(logout.headers['cache-control']).toBe('no-store');
    });

    it('still clears the local session when the provider cannot be reached', async () => {
      const gone = await startMockOidcProvider();
      const goneUrl = gone.url;
      await gone.close();
      const stack = await startStack({}, { issuerUrl: goneUrl });
      const nowSeconds = Math.floor(Date.now() / 1000);
      const sessionCookie = encodeSession(stack.config, { idToken: 'test-id-token', sub: 'user-1', orgId: 'org-1', roles: ['member'], authTime: nowSeconds, exp: nowSeconds + 3600 });

      const logout = await stack.app.inject({ method: 'POST', url: '/auth/logout', headers: { origin: 'http://app.example.test' }, cookies: { [stack.config.cookieName]: sessionCookie } });
      expect(logout.statusCode).toBe(200);
      expect(logout.body).toContain('Your identity provider session could not be ended.');
      expect(logout.headers.location).toBeUndefined();
      expect(findCookie(logout, stack.config.cookieName)).toMatchObject({ value: '', maxAge: 0 });
    });

    it('sends no address when the provider has no logout page', async () => {
      const stack = await startStack({ endSessionEndpoint: null });
      const sessionCookie = cookieValue(await signIn(stack), stack.config.cookieName);
      const logout = await stack.app.inject({ method: 'POST', url: '/auth/logout', headers: { origin: 'http://app.example.test' }, cookies: { [stack.config.cookieName]: sessionCookie } });
      expect(logout.statusCode).toBe(200);
      expect(logout.body).toContain('Your identity provider session could not be ended.');
      expect(logout.headers.location).toBeUndefined();
    });

    // The browser follows whatever address it is given, so one that is not http(s) must never reach it.
    it.each([
      ['a javascript: address', 'javascript:alert(1)'],
      ['a data: address', 'data:text/html,hi'],
    ])('sends no address when the provider advertises %s as its logout page, and still clears the session', async (_name, endSessionEndpoint) => {
      const stack = await startStack({ endSessionEndpoint });
      const nowSeconds = Math.floor(Date.now() / 1000);
      const sessionCookie = encodeSession(stack.config, { idToken: 'test-id-token', sub: 'user-1', orgId: 'org-1', roles: ['member'], authTime: nowSeconds, exp: nowSeconds + 3600 });

      const logout = await stack.app.inject({ method: 'POST', url: '/auth/logout', headers: { origin: 'http://app.example.test' }, cookies: { [stack.config.cookieName]: sessionCookie } });

      expect(logout.statusCode).toBe(200);
      expect(logout.body).toContain('Your identity provider session could not be ended.');
      expect(logout.headers.location).toBeUndefined();
      expect(findCookie(logout, stack.config.cookieName)).toMatchObject({ value: '', maxAge: 0 });
    });
  });
});

it('binds a fresh OIDC step-up to this approval, requester and existing session', async () => {
  const stack = await startStack({ user: { ...DEFAULT_MOCK_USER, authTime: Math.floor(Date.now() / 1000) } });
  const session = cookieValue(await signIn(stack), stack.config.cookieName), approval = 'a'.repeat(64);
  const login = await stack.app.inject({ url: `/auth/login?approval=${approval}&returnTo=/workspace`, cookies: { [stack.config.cookieName]: session } });
  const address = new URL(String(login.headers.location));
  expect(address.searchParams.get('max_age')).toBe('0');
  const provider = await fetch(address, { redirect: 'manual' });
  const callback = new URL(provider.headers.get('location')!);
  const cookies = { [stack.config.flowCookieName]: cookieValue(login, stack.config.flowCookieName), [stack.config.cookieName]: session };
  const reply = await stack.app.inject({ url: callback.pathname + callback.search, cookies });
  expect(reply.statusCode).toBe(302);
  expect(decodeSession(stack.config, cookieValue(reply, stack.config.cookieName))).toMatchObject({ stepUpApproval: approval });
});

it.each(['missing', 'old', 'future', 'swapped_session', 'different_requester'])('refuses %s OIDC step-up evidence', async failure => {
  const authTime = Math.floor(Date.now() / 1000);
  const user: typeof DEFAULT_MOCK_USER = { ...DEFAULT_MOCK_USER, authTime: failure === 'old' ? authTime - 301 : failure === 'future' ? authTime + 60 : authTime };
  if (failure === 'missing') delete user.authTime;
  const stack = await startStack({ user });
  const original = encodeSession(stack.config, { sub: failure === 'different_requester' ? 'someone-else' : user.sub, orgId: user.orgId!, roles: [], authTime: 0, exp: authTime + 600 });
  const login = await stack.app.inject({ url: `/auth/login?approval=${'a'.repeat(64)}`, cookies: { [stack.config.cookieName]: original } });
  const authorise = await fetch(String(login.headers.location), { redirect: 'manual' });
  const callback = new URL(authorise.headers.get('location')!);
  const reply = await stack.app.inject({ url: callback.pathname + callback.search, cookies: {
    [stack.config.flowCookieName]: cookieValue(login, stack.config.flowCookieName),
    [stack.config.cookieName]: failure === 'swapped_session' ? encodeSession(stack.config, decodeSession(stack.config, original)) : original,
  } });
  expect(reply.statusCode).toBe(400);
});
