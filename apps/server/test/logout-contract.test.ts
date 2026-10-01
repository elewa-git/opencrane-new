// POST /auth/logout answers with the LogoutResponse shape from
// @opencrane/protocol, the one the web app reads it with. @opencrane/auth is
// stubbed here so the test can hand the route any address, including the ones
// the identity-provider client would normally have refused already, and check
// that the route still sends only an http(s) address or null.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { logoutResponseSchema } from '@opencrane/protocol';

vi.mock('@opencrane/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@opencrane/auth')>()),
  buildLogoutUrl: vi.fn(),
}));

const { buildLogoutUrl } = await import('@opencrane/auth');
const { buildServer } = await import('../src/server.ts');
const { testAuthConfig } = await import('./support/test-auth-config.ts');

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
    app = buildServer(testAuthConfig(), { logDestination: { write: (msg: string) => void chunks.push(msg) } });
    return { app, lines: () => chunks.join('').split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>) };
  }

  it.each([
    ['an https address', 'https://idp.example/logout?client_id=c'],
    ['a localhost address', 'http://localhost:8080/oidc/v1/end_session'],
    ['no address', null],
  ])('sends %s as the shared schema allows', async (_name, address) => {
    vi.mocked(buildLogoutUrl).mockResolvedValue(address);
    const server = loggingServer();

    const response = await server.app.inject({ method: 'POST', url: '/auth/logout' });

    expect(response.statusCode).toBe(200);
    expect(logoutResponseSchema.parse(response.json())).toEqual({ endSessionUrl: address });
    expect(server.lines().some((line) => line['level'] === 40)).toBe(false);
  });

  it.each([
    ['a javascript: address', 'javascript:alert(1)'],
    ['a data: address', 'data:text/html,hi'],
    ['an ftp: address', 'ftp://idp.example/logout'],
  ])('sends none, and still clears the session, when it is given %s', async (_name, address) => {
    vi.mocked(buildLogoutUrl).mockResolvedValue(address);
    const server = loggingServer();

    const response = await server.app.inject({ method: 'POST', url: '/auth/logout' });

    expect(response.statusCode).toBe(200);
    expect(logoutResponseSchema.parse(response.json())).toEqual({ endSessionUrl: null });
    expect(response.cookies.find((cookie) => cookie.name === testAuthConfig().cookieName)).toMatchObject({ value: '', maxAge: 0 });
    // The refused address is not in the log, only the fact that it was refused.
    expect(JSON.stringify(server.lines())).not.toContain(address);
    expect(server.lines().some((line) => line['level'] === 40 && String(line['msg']).includes('is not an http(s) address'))).toBe(true);
  });
});
