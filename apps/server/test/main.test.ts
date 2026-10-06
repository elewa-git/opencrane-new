// Start the server in a separate Node process, as production does. This checks
// that `main.ts` starts successfully and that the process does not print URL
// secrets to stdout.
import { setTimeout as sleep } from 'node:timers/promises';
import { startServer, TEST_OIDC_ENV, parseJsonLines, loggedUrls, sendRaw, type RunningServer } from './support/process.ts';
import { afterEach, describe, expect, it } from 'vitest';
import { encodeSession, loadAuthConfig } from '@opencrane/auth';
import { event, natsFixture } from '@opencrane/event-store/testing';

describe('main.ts under the real Node runtime', () => {
  let server: RunningServer | undefined;

  afterEach(async () => {
    await server?.stop();
    server = undefined;
  });

  it('starts the configured membership route and appends to real NATS', async () => {
    const nats = await natsFixture();
    try {
      const env = { ...TEST_OIDC_ENV, OIDC_EXPECTED_ORG_ID: 'org-acme',
        ...nats.env(), SILO_ID: 'acme' };
      server = await startServer(env);
      const invited = event('invite-process', 'member-alice', 'member.invited');
      await nats.store.append({ expectedSequence: 0, event: { ...invited, silo: 'acme',
        data: { ...invited.data, invitationId: 'invite-process',
          invitedIdentity: { issuer: env.OIDC_ISSUER_URL, sub: 'alice' },
          expiresAt: new Date(Date.now() + 60_000).toISOString() } } });
      const config = loadAuthConfig(env);
      const cookie = encodeSession(config, { sub: 'alice', orgId: 'org-acme', roles: [],
        authTime: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 60 });
      const response = await fetch(`http://127.0.0.1:${server.port}/members/join`, {
        method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://app.example.test',
          cookie: `${config.cookieName}=${cookie}` },
        body: JSON.stringify({ memberId: 'alice', invitationId: 'invite-process', commandId: 'join-process', displayName: 'Alice' }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: 'joined', memberId: 'alice', sequence: 2 });
      expect(await nats.store.head()).toBe(2);
    } finally {
      await server?.stop();
      await nats.close();
    }
  }, 40_000);

  it('refuses startup when NATS is enabled without TLS credentials', async () => {
    await expect(startServer({ NATS_URL: '127.0.0.1:4222', SILO_ID: 'acme',
      OIDC_EXPECTED_ORG_ID: 'org-acme' })).rejects.toThrow('NATS_CA_FILE is required');
  }, 40_000);

  it('starts, serves /healthz, and never prints a secret from a request URL: known route, unknown route, plain GET to /ws, the sign-in callback, or a URL Node cannot parse', async () => {
    server = await startServer();
    const { port } = server;
    const get = (path: string): Promise<Response> => fetch(`http://127.0.0.1:${port}${path}`);

    const known = await get('/healthz?token=SECRET_MAIN_KNOWN');
    expect(known.status).toBe(200);
    expect(await known.json()).toEqual({ status: 'ok' });
    // Check Fastify's missing-route message and a normal GET to the WebSocket path.
    expect((await get('/nope?token=SECRET_MAIN_404&code=SECRET_MAIN_CODE')).status).toBe(404);
    expect((await get('/ws?token=SECRET_MAIN_WS')).status).toBe(404);
    // The callback URL and login-flow cookie contain secrets. An invalid cookie
    // makes the route refuse the request without contacting an identity provider.
    const callback = await fetch(`http://127.0.0.1:${port}/auth/callback?code=SECRET_MAIN_AUTH_CODE&state=SECRET_MAIN_AUTH_STATE`, {
      headers: { cookie: 'oc_auth_flow=SECRET_MAIN_FLOW_COOKIE' },
    });
    expect(callback.status).toBe(400);
    // `fetch` will not send this invalid request line, so send it through a raw socket.
    const raw = await sendRaw(port, 'GET //[x?token=SECRET_MAIN_BRACKET HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
    expect(raw).toMatch(/^HTTP\/1\.1 \d{3} /u);

    // Wait for the last request to appear in redacted form before checking the output.
    const running = server;
    for (let tries = 0; tries < 60 && !loggedUrls(running.stdout()).includes('//[x'); tries += 1) {
      await sleep(50);
    }

    const stdout = server.stdout();
    expect(stdout).not.toContain('SECRET_MAIN_');
    const lines = parseJsonLines(stdout);
    const messages = lines.map((line) => line['msg']);
    // Check that every line is JSON and that the logged URLs have been redacted.
    expect(lines).toHaveLength(stdout.split('\n').filter(Boolean).length);
    expect(loggedUrls(stdout)).toEqual(expect.arrayContaining(['/healthz', '/nope', '/auth/callback', '//[x']));
    expect(messages).toContain('sign-in callback refused: login flow cookie is invalid');
    expect(messages).toContain('Route GET:/nope not found');
    expect(messages).toContain('Route GET:/ws not found');
    // Use the same request id field name as the rest of the logs.
    expect(lines.some((line) => typeof line['request_id'] === 'string')).toBe(true);
    expect(lines.some((line) => 'reqId' in line)).toBe(false);
  }, 40_000);
});
