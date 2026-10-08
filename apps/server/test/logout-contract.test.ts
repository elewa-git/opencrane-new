import { record as asRecord } from './record.ts';
// The route must keep unsafe provider URLs out of navigation and logs.
// Real provider behaviour is checked by auth-flow and the dev-stack journey.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

vi.mock('@opencrane/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@opencrane/auth')>()),
  buildLogoutUrl: vi.fn(),
}));

const { buildLogoutUrl, encodeSession } = await import('@opencrane/auth');
const { buildServer } = await import('../src/server.ts');
const { testAuthConfig } = await import('./support/test-auth-config.ts');
const authConfig = testAuthConfig({ expectedOrgId: 'org' });

function logoutRequest() {
  const session = {
    sub: 'user',
    orgId: 'org',
    roles: [],
    authTime: 1,
    exp: Math.floor(Date.now() / 1000) + 300,
    idToken: 'test-id-token',
  };
  const cookie = encodeSession(authConfig, session);
  const cookies = { [authConfig.cookieName]: cookie };
  const origin = new URL(authConfig.redirectUri).origin;
  const headers = { origin };
  const request = { method: 'POST' as const, url: '/auth/logout', headers, cookies };
  return request;
}

function isSessionCookie(cookie: { name: string }): boolean {
  return cookie.name === authConfig.cookieName;
}

describe('POST /auth/logout reply', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
    vi.unstubAllEnvs();
  });

  /** Build a server that logs to memory at info level (vitest.config.ts turns logging off by default). */
  function loggingServer(): { app: FastifyInstance; lines: () => Record<string, unknown>[] } {
    vi.stubEnv('LOG_LEVEL', 'info');
    const chunks: string[] = [];
    function writeLog(message: string): void {
      chunks.push(message);
    }
    const logDestination = { write: writeLog };
    const options = { logDestination };
    app = buildServer(authConfig, options);
    return { app, lines: () => chunks.join('').split('\n').filter(Boolean).map((line) => asRecord(JSON.parse(line))) };
  }

  it.each([
    ['an https address', 'https://idp.example/logout?client_id=c'],
    ['a localhost address', 'http://localhost:8080/oidc/v1/end_session'],
    ['no address', null],
  ])('navigates to %s or reports local-only sign-out', async (_name, address) => {
    vi.mocked(buildLogoutUrl).mockResolvedValue(address);
    const server = loggingServer();

    const request = logoutRequest();
    const response = await server.app.inject(request);

    expect(response.statusCode).toBe(address ? 303 : 200);
    expect(response.headers.location).toBe(address ?? undefined);
    if (address) expect(response.body).toBe('');
    else expect(response.body).toContain('Your identity provider session could not be ended.');
    expect(server.lines().some((line) => line['level'] === 40)).toBe(false);
  });

  it.each([
    ['a javascript: address', 'javascript:alert(1)'],
    ['a data: address', 'data:text/html,hi'],
    ['an ftp: address', 'ftp://idp.example/logout'],
  ])('sends none, and still clears the session, when it is given %s', async (_name, address) => {
    vi.mocked(buildLogoutUrl).mockResolvedValue(address);
    const server = loggingServer();

    const request = logoutRequest();
    const response = await server.app.inject(request);

    expect(response.statusCode).toBe(200);
    expect(response.headers.location).toBeUndefined();
    expect(response.body).toContain('Your identity provider session could not be ended.');
    const sessionCookie = response.cookies.find(isSessionCookie);
    expect(sessionCookie).toMatchObject({ value: '', maxAge: 0 });
    // The refused address is not in the log, only the fact that it was refused.
    expect(JSON.stringify(server.lines())).not.toContain(address);
    expect(server.lines().some((line) => line['level'] === 40 && String(line['msg']).includes('is not an http(s) address'))).toBe(true);
  });
});
