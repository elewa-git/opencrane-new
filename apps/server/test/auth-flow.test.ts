import assert from 'node:assert/strict';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { encodeSession, type AuthConfig } from '@opencrane/auth';
import { logoutResponseSchema } from '@opencrane/protocol';
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
    const stack = await startStack();
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
    expect(me.user).toMatchObject({ sub: 'user-1', orgId: 'org-1', roles: ['member'] });
    // The provider's own auth_time, not the moment the callback ran.
    expect(me.user?.authTime).toBe(DEFAULT_MOCK_USER.authTime);

    const logout = await stack.app.inject({ method: 'POST', url: '/auth/logout', cookies: { [stack.config.cookieName]: sessionCookie } });
    // The reply is checked with the schema the web app reads it with.
    expect(logoutResponseSchema.parse(logout.json()).endSessionUrl).toContain(`${stack.provider.url}/endsession`);
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
      const expired = encodeSession(stack.config, { sub: 'user-1', orgId: 'org-1', roles: ['member'], authTime: nowSeconds - 7200, exp: nowSeconds - 1 });
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
        { orgClaim, rolesClaim },
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
    it('asks the provider to send the person back to postLogoutRedirectUri, naming the client', async () => {
      const stack = await startStack({}, { postLogoutRedirectUri: 'http://app.example.test/signed-out' });
      const logout = await stack.app.inject({ method: 'POST', url: '/auth/logout' });
      const endSession = new URL(logoutResponseSchema.parse(logout.json()).endSessionUrl!);
      expect(endSession.origin + endSession.pathname).toBe(`${stack.provider.url}/endsession`);
      expect(endSession.searchParams.get('post_logout_redirect_uri')).toBe('http://app.example.test/signed-out');
      expect(endSession.searchParams.get('client_id')).toBe(stack.provider.clientId);
    });

    it('still clears the local session when the provider cannot be reached', async () => {
      const gone = await startMockOidcProvider();
      const goneUrl = gone.url;
      await gone.close();
      const stack = await startStack({}, { issuerUrl: goneUrl });
      const nowSeconds = Math.floor(Date.now() / 1000);
      const sessionCookie = encodeSession(stack.config, { sub: 'user-1', orgId: 'org-1', roles: ['member'], authTime: nowSeconds, exp: nowSeconds + 3600 });

      const logout = await stack.app.inject({ method: 'POST', url: '/auth/logout', cookies: { [stack.config.cookieName]: sessionCookie } });
      expect(logout.statusCode).toBe(200);
      expect(logoutResponseSchema.parse(logout.json())).toEqual({ endSessionUrl: null });
      expect(findCookie(logout, stack.config.cookieName)).toMatchObject({ value: '', maxAge: 0 });
    });

    it('sends no address when the provider has no logout page', async () => {
      const stack = await startStack({ endSessionEndpoint: null });
      const logout = await stack.app.inject({ method: 'POST', url: '/auth/logout' });
      expect(logout.statusCode).toBe(200);
      expect(logoutResponseSchema.parse(logout.json())).toEqual({ endSessionUrl: null });
    });

    // The browser follows whatever address it is given, so one that is not http(s) must never reach it.
    it.each([
      ['a javascript: address', 'javascript:alert(1)'],
      ['a data: address', 'data:text/html,hi'],
    ])('sends no address when the provider advertises %s as its logout page, and still clears the session', async (_name, endSessionEndpoint) => {
      const stack = await startStack({ endSessionEndpoint });
      const nowSeconds = Math.floor(Date.now() / 1000);
      const sessionCookie = encodeSession(stack.config, { sub: 'user-1', orgId: 'org-1', roles: ['member'], authTime: nowSeconds, exp: nowSeconds + 3600 });

      const logout = await stack.app.inject({ method: 'POST', url: '/auth/logout', cookies: { [stack.config.cookieName]: sessionCookie } });

      expect(logout.statusCode).toBe(200);
      expect(logout.json()).toEqual({ endSessionUrl: null });
      expect(findCookie(logout, stack.config.cookieName)).toMatchObject({ value: '', maxAge: 0 });
    });
  });
});
