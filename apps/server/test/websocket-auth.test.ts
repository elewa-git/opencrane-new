import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { WebSocket } from 'ws';
import { encodeSession } from '@opencrane/auth';
import { buildServer } from '../src/server.ts';
import { attachWebSocketServer, WEBSOCKET_PATH } from '../src/websocket.ts';
import { replaceInCiphertext, tamperCookie, testAuthConfig, truncateAuthTag } from './support/test-auth-config.ts';

const authConfig = testAuthConfig();
const nowSeconds = Math.floor(Date.now() / 1000);
// testAuthConfig's redirectUri is https://app.example.test/auth/callback,
// so this is the one Origin the socket upgrade accepts.
const ALLOWED_ORIGIN = 'https://app.example.test';
const validSession = { sub: 'user-1', orgId: 'org-1', roles: [], authTime: nowSeconds, exp: nowSeconds + 3600 };
const validSessionCookie = () => encodeSession(authConfig, validSession);

async function startServer(): Promise<{ app: FastifyInstance; url: string }> {
  const app = buildServer(authConfig);
  await app.listen({ port: 0, host: '127.0.0.1' });
  attachWebSocketServer(app.server, app.log, authConfig);
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('expected a TCP address');
  return { app, url: `ws://127.0.0.1:${address.port}${WEBSOCKET_PATH}` };
}

/** Resolves with the HTTP status of a rejected upgrade, or 'open' if it connected. */
function attemptUpgrade(url: string, headers: Record<string, string> = {}): Promise<number | 'open'> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    socket.on('open', () => {
      resolve('open');
      socket.close();
    });
    socket.on('unexpected-response', (_request, response) => {
      resolve(response.statusCode ?? 0);
    });
    socket.on('error', (err) => {
      // A rejected upgrade may also surface here once 'unexpected-response'
      // has already resolved the promise; only reject if nothing has.
      reject(err);
    });
  });
}

describe('WebSocket upgrade requires a session', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('refuses an upgrade with no session cookie at all, with 401, before completing it', async () => {
    const started = await startServer();
    app = started.app;
    const result = await attemptUpgrade(started.url, { Origin: ALLOWED_ORIGIN });
    expect(result).toBe(401);
  });

  it('refuses an upgrade with a tampered session cookie', async () => {
    const started = await startServer();
    app = started.app;
    const result = await attemptUpgrade(started.url, { Origin: ALLOWED_ORIGIN, Cookie: `${authConfig.cookieName}=${tamperCookie(validSessionCookie())}` });
    expect(result).toBe(401);
  });

  it('refuses an upgrade with a session cookie whose authentication tag has been cut down to 4 bytes', async () => {
    const started = await startServer();
    app = started.app;
    const result = await attemptUpgrade(started.url, { Origin: ALLOWED_ORIGIN, Cookie: `${authConfig.cookieName}=${truncateAuthTag(validSessionCookie(), 4)}` });
    expect(result).toBe(401);
  });

  it('refuses an upgrade with a session cookie forged to say org-2 (valid JSON, so only the tag can catch it)', async () => {
    const started = await startServer();
    app = started.app;
    const forged = replaceInCiphertext(validSessionCookie(), JSON.stringify(validSession), '"org-1"', '"org-2"');
    const result = await attemptUpgrade(started.url, { Origin: ALLOWED_ORIGIN, Cookie: `${authConfig.cookieName}=${forged}` });
    expect(result).toBe(401);
  });

  it('refuses an upgrade with an expired session cookie', async () => {
    const started = await startServer();
    app = started.app;
    const expired = encodeSession(authConfig, { sub: 'user-1', orgId: 'org-1', roles: [], authTime: nowSeconds - 7200, exp: nowSeconds - 1 });
    const result = await attemptUpgrade(started.url, { Origin: ALLOWED_ORIGIN, Cookie: `${authConfig.cookieName}=${expired}` });
    expect(result).toBe(401);
  });

  it('accepts an upgrade with a valid session cookie and the expected Origin', async () => {
    const started = await startServer();
    app = started.app;
    const result = await attemptUpgrade(started.url, { Origin: ALLOWED_ORIGIN, Cookie: `${authConfig.cookieName}=${validSessionCookie()}` });
    expect(result).toBe('open');
  });

  it('refuses an upgrade with a valid session cookie but no Origin header', async () => {
    const started = await startServer();
    app = started.app;
    const result = await attemptUpgrade(started.url, { Cookie: `${authConfig.cookieName}=${validSessionCookie()}` });
    expect(result).toBe(403);
  });

  it('refuses an upgrade with a valid session cookie but a foreign Origin (cross-site WebSocket hijacking)', async () => {
    const started = await startServer();
    app = started.app;
    const result = await attemptUpgrade(started.url, { Origin: 'https://evil.example', Cookie: `${authConfig.cookieName}=${validSessionCookie()}` });
    expect(result).toBe(403);
  });
});
