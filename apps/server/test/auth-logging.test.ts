import assert from 'node:assert/strict';
import { record as asRecord } from './record.ts';
// The auth routes sit on top of the observability logger. These tests read the
// log lines the server writes while people sign in, fail to sign in and sign
// out, and check that no code, state, cookie, token or session value is in any
// of them.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import { startMockOidcProvider, type MockOidcProvider } from './support/mock-oidc-provider.ts';
import { testAuthConfig } from './support/test-auth-config.ts';

type Response = Awaited<ReturnType<FastifyInstance['inject']>>;
type LogLine = Record<string, unknown>;

interface LoggedStack {
  provider: MockOidcProvider;
  app: FastifyInstance;
  flowCookieName: string;
  sessionCookieName: string;
  /** Everything written to the log so far, as one string. */
  text: () => string;
  /** The log lines, parsed. Every line must be JSON. */
  lines: () => LogLine[];
}

const stacks: LoggedStack[] = [];

afterEach(async () => {
  for (const stack of stacks.splice(0)) {
    await stack.app.close();
    await stack.provider.close();
  }
  vi.unstubAllEnvs();
});

/** A server wired to its own mock provider, logging to memory at info level (vitest.config.ts turns logging off by default). */
async function startLoggedStack(): Promise<LoggedStack> {
  vi.stubEnv('LOG_LEVEL', 'info');
  const provider = await startMockOidcProvider();
  const config = testAuthConfig({
    issuerUrl: provider.url,
    clientId: provider.clientId,
    redirectUri: 'http://app.example.test/auth/callback',
    cookieSecure: false,
    sessionMaxAgeSeconds: 3600,
    // Our own loopback mock, never a real deployment's issuer.
    allowInsecureRequests: true,
  });
  const chunks: string[] = [];
  const app = buildServer(config, { logDestination: { write: (msg: string) => void chunks.push(msg) } });
  const text = (): string => chunks.join('');
  const stack: LoggedStack = {
    provider,
    app,
    flowCookieName: config.flowCookieName,
    sessionCookieName: config.cookieName,
    text,
    lines: () => text().split('\n').filter(Boolean).map((line) => asRecord(JSON.parse(line))),
  };
  stacks.push(stack);
  return stack;
}

function cookieValue(response: Response, name: string): string {
  const cookie = response.cookies.find((entry) => entry.name === name);
  if (!cookie) {
    throw new Error(`expected a ${name} cookie in the response`);
  }
  return cookie.value;
}

/** The logged `req.url` of every "incoming request" line. */
function loggedRequestUrls(stack: LoggedStack): string[] {
  return stack.lines().flatMap((line) => {
    const url = asRecord(line['req'] ?? {})['url'];
    return line['msg'] === 'incoming request' && typeof url === 'string' ? [url] : [];
  });
}

/** Runs /auth/login and the provider's authorize step, stopping at the callback. */
async function startLogin(stack: LoggedStack) {
  const login = await stack.app.inject({ method: 'GET', url: '/auth/login' });
  expect(login.statusCode).toBe(302);
  const flowCookie = cookieValue(login, stack.flowCookieName);
  // The provider is a real loopback server that app.inject cannot reach, so
  // the test makes this one request itself, as the browser would.
  assert(typeof login.headers.location === 'string');
  const authorize = await fetch(login.headers.location, { redirect: 'manual' });
  const callbackUrl = new URL(authorize.headers.get('location')!);
  return {
    flowCookie,
    callbackQuery: `${callbackUrl.pathname}${callbackUrl.search}`,
    code: callbackUrl.searchParams.get('code')!,
    state: callbackUrl.searchParams.get('state')!,
  };
}

describe('auth routes and the log', () => {
  it('redacts the code and state of the /auth/callback URL when a request fails', async () => {
    const stack = await startLoggedStack();

    const response = await stack.app.inject({
      method: 'GET',
      url: '/auth/callback?code=SECRET_CODE_123&state=SECRET_STATE_456',
      cookies: { [stack.flowCookieName]: 'SECRET_FLOW_COOKIE' },
    });

    // The flow cookie is not a real one, so the callback is refused.
    expect(response.statusCode).toBe(400);
    expect(stack.text()).not.toMatch(/SECRET_/u);
    expect(loggedRequestUrls(stack)).toEqual(['/auth/callback']);
    // The route says why it refused, in words, and keeps its own line free of the cookie.
    expect(stack.lines().some((line) => line['level'] === 40 && line['msg'] === 'sign-in callback refused: login flow cookie is invalid')).toBe(true);
  });

  it('redacts the code and state when a request has no login in progress, and logs why it was refused', async () => {
    const stack = await startLoggedStack();

    const response = await stack.app.inject({ method: 'GET', url: '/auth/callback?code=SECRET_CODE_NOFLOW&state=SECRET_STATE_NOFLOW' });

    expect(response.statusCode).toBe(400);
    expect(stack.text()).not.toMatch(/SECRET_/u);
    expect(loggedRequestUrls(stack)).toEqual(['/auth/callback']);
    expect(stack.lines().some((line) => line['level'] === 40 && line['msg'] === 'sign-in callback refused: no login is in progress')).toBe(true);
  });

  it('keeps the code, state, cookies and session out of the log through a whole successful sign-in and sign-out', async () => {
    const stack = await startLoggedStack();
    const { flowCookie, callbackQuery, code, state } = await startLogin(stack);

    const callback = await stack.app.inject({ method: 'GET', url: callbackQuery, cookies: { [stack.flowCookieName]: flowCookie } });
    expect(callback.statusCode).toBe(302);
    const sessionCookie = cookieValue(callback, stack.sessionCookieName);

    await stack.app.inject({ method: 'GET', url: '/auth/me', cookies: { [stack.sessionCookieName]: sessionCookie } });
    const logout = await stack.app.inject({ method: 'POST', url: '/auth/logout', headers: { origin: 'http://app.example.test' }, cookies: { [stack.sessionCookieName]: sessionCookie } });
    expect(logout.statusCode).toBe(303);

    const text = stack.text();
    const idToken = new URL(String(logout.headers.location)).searchParams.get('id_token_hint');
    expect(Boolean(idToken) && !text.includes(idToken!)).toBe(true);
    expect(logout.body).toBe('');
    // The values the test knows about, one by one, so a failure names the leak.
    for (const [name, secret] of [['code', code], ['state', state], ['flow cookie', flowCookie], ['session cookie', sessionCookie]] as const) {
      expect(text, `the ${name} must not be in the log`).not.toContain(secret);
    }
    expect(loggedRequestUrls(stack)).toContain('/auth/callback');
    const messages = stack.lines().map((line) => line['msg']);
    expect(messages).toContain('sign-in completed');
    expect(messages).toContain('signed out');
    // The set-cookie header and the cookie request header are not logged at all.
    expect(text).not.toMatch(/set-cookie|"cookie"/iu);
  });

  it('logs a rejected login with a fixed reason and none of what the provider sent back', async () => {
    const stack = await startLoggedStack();
    const { flowCookie, callbackQuery, code } = await startLogin(stack);
    // Same code, wrong state: the check against the login that started it fails.
    const wrongState = callbackQuery.replace(/state=[^&]+/u, 'state=SECRET_WRONG_STATE');

    const callback = await stack.app.inject({ method: 'GET', url: wrongState, cookies: { [stack.flowCookieName]: flowCookie } });

    expect(callback.statusCode).toBe(400);
    expect(stack.text()).not.toContain(code);
    expect(stack.text()).not.toContain('SECRET_WRONG_STATE');
    expect(stack.text()).not.toContain(flowCookie);
    const failure = stack.lines().find((line) => line['level'] === 40 && String(line['msg']).startsWith('sign-in failed'));
    expect(failure?.['msg']).toBe('sign-in failed: the identity provider rejected the login');
    // The error object (which carries the provider's response) is deliberately not logged.
    expect(failure).not.toHaveProperty('err');
  });
});
