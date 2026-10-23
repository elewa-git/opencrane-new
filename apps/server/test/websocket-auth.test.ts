import { afterEach, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import type { FastifyInstance } from 'fastify';
import { connect } from 'node:net';
import { WebSocket } from 'ws';
import { encodeSession, type AuthConfig } from '@opencrane/auth';
import { buildServer } from '../src/server.ts';
import { attachWebSocketServer, WEBSOCKET_PATH } from '../src/websocket.ts';
import { replaceInCiphertext, tamperCookie, testAuthConfig, truncateAuthTag } from './support/test-auth-config.ts';

const authConfig = testAuthConfig({ expectedOrgId: 'org-1' });
const nowSeconds = Math.floor(Date.now() / 1000);
// testAuthConfig's redirectUri is https://app.example.test/auth/callback,
// so this is the one Origin the socket upgrade accepts.
const ALLOWED_ORIGIN = 'https://app.example.test';
const validSession = { sub: 'user-1', orgId: 'org-1', roles: [], authTime: nowSeconds, exp: nowSeconds + 3600 };
const validSessionCookie = () => encodeSession(authConfig, validSession);

async function startServer(config: AuthConfig = authConfig): Promise<{ app: FastifyInstance; url: string }> {
  const app = buildServer(config);
  await app.listen({ port: 0, host: '127.0.0.1' });
  attachWebSocketServer(app.server, app.log, config);
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

function sendUnmaskedFrame(port: number, cookie: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    let upgraded = false;
    const timeout = setTimeout(() => reject(new Error('socket did not close')), 3000);
    socket.on('connect', () => socket.write([
      'GET /ws HTTP/1.1',
      `Host: 127.0.0.1:${port}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Version: 13',
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
      `Origin: ${ALLOWED_ORIGIN}`,
      `Cookie: ${authConfig.cookieName}=${cookie}`,
      '',
      '',
    ].join('\r\n')));
    socket.on('data', (chunk: Buffer) => {
      if (!upgraded && chunk.toString('latin1').startsWith('HTTP/1.1 101')) {
        upgraded = true;
        socket.write(Buffer.from([0x81, 0x02, 0x7b, 0x7d]));
      }
    });
    socket.on('close', () => {
      clearTimeout(timeout);
      if (upgraded) resolve();
      else reject(new Error('upgrade did not complete'));
    });
    socket.on('error', reject);
  });
}

describe('WebSocket upgrade requires a session', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    await app?.close();
    app = undefined;
  });

  async function authenticatedSocket() {
    const started = await startServer();
    app = started.app;
    const headers = {
      Origin: ALLOWED_ORIGIN,
      Cookie: `${authConfig.cookieName}=${validSessionCookie()}`,
    };
    const socket = new WebSocket(started.url, { headers });
    await once(socket, 'open');
    return socket;
  }

  async function closesExcessTrafficRetryably(): Promise<void> {
    const socket = await authenticatedSocket();
    // Hold the window still while real frames travel through the authenticated connection.
    vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    const replies: string[] = [];
    function recordReply(data: Buffer): void {
      replies.push(data.toString());
    }
    function waitForClose(resolve: (close: { code: number; reason: string }) => void): void {
      function closed(code: number, reason: Buffer): void {
        resolve({ code, reason: reason.toString() });
      }
      socket.once('close', closed);
    }
    const closed = new Promise(waitForClose);
    socket.on('message', recordReply);
    try {
      for (let index = 1; index <= 20; index++) {
        socket.send(JSON.stringify({ type: 'hello', text: `allowed-${index}` }));
      }
      socket.send(JSON.stringify({ type: 'hello', text: 'excess message' }));
      expect(await closed).toEqual({ code: 1013, reason: 'rate limit' });
      expect(replies).toHaveLength(20);
      expect(replies[0]).toContain('"text":"allowed-1"');
      expect(replies[19]).toContain('"text":"allowed-20"');
      expect(replies.join('\n')).not.toContain('excess message');
    } finally {
      socket.terminate();
    }
  }

  it('closes the 21st message retryably before handling it', closesExcessTrafficRetryably);

  async function acceptsFreshWindow(): Promise<void> {
    const socket = await authenticatedSocket();
    const windowStart = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(windowStart);
    try {
      for (const elapsed of [0, 1000]) {
        clock.mockReturnValue(windowStart + elapsed);
        for (let index = 1; index <= 20; index++) {
          const received = once(socket, 'message');
          socket.send(JSON.stringify({ type: 'hello', text: 'within limit' }));
          await received;
        }
        expect(socket.readyState).toBe(WebSocket.OPEN);
      }
    } finally {
      socket.terminate();
    }
  }

  it('accepts twenty messages and another twenty in a new window', acceptsFreshWindow);

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

  async function refusesWithoutOrganisation(): Promise<void> {
    const config = testAuthConfig();
    const started = await startServer(config);
    app = started.app;
    const headers = {
      Origin: ALLOWED_ORIGIN,
      Cookie: `${config.cookieName}=${encodeSession(config, validSession)}`,
    };
    const result = await attemptUpgrade(started.url, headers);
    expect(result).toBe(403);
  }

  it('refuses a valid development session when no organisation is configured',
    refusesWithoutOrganisation);

  it('keeps the organisation pin while accepting only an exact identity exception', async () => {
    const config = testAuthConfig({ expectedOrgId: 'org-1',
      extraIdentities: [{ issuer: 'https://idp.example.test', subject: 'owner' }] });
    const started = await startServer(config);
    app = started.app;
    const cookie = (sub: string) => `${config.cookieName}=${encodeSession(config, { ...validSession, sub, orgId: 'org-other' })}`;
    expect(await attemptUpgrade(started.url, { Origin: ALLOWED_ORIGIN, Cookie: cookie('other') })).toBe(403);
    expect(await attemptUpgrade(started.url, { Origin: ALLOWED_ORIGIN, Cookie: cookie('owner') })).toBe('open');
  });

  it('closes a session that expires between authentication and connection while the server stays healthy', async () => {
    const authenticatedAt = new Date('2026-10-01T12:00:00.000Z');
    const expiredAtConnection = new Date('2026-10-01T12:00:01.000Z');
    const session = { ...validSession, exp: expiredAtConnection.getTime() / 1000 };
    const times = [authenticatedAt, expiredAtConnection];
    const now = () => times.shift() ?? expiredAtConnection;
    app = buildServer(authConfig);
    await app.listen({ port: 0, host: '127.0.0.1' });
    attachWebSocketServer(app.server, app.log, authConfig, undefined, now);
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('expected a TCP address');
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}${WEBSOCKET_PATH}`, {
      headers: {
        Origin: ALLOWED_ORIGIN,
        Cookie: `${authConfig.cookieName}=${encodeSession(authConfig, session)}`,
      },
    });

    const closed = await new Promise<{ code: number; reason: string }>((resolve, reject) => {
      socket.on('close', (code, reason) => resolve({ code, reason: reason.toString() }));
      socket.on('error', reject);
    });

    expect(closed).toEqual({ code: 1008, reason: 'session unavailable' });
    expect(times).toEqual([]);
    const health = await fetch(`http://127.0.0.1:${address.port}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: 'ok' });
  });

  it('refuses malformed and unknown upgrade targets without crashing the server', async () => {
    const started = await startServer(); app = started.app;
    const port = Number(new URL(started.url).port);
    for (const target of ['//[', '/unknown']) {
      const response = await new Promise<string>((resolve, reject) => {
        const socket = connect(port, '127.0.0.1'); let bytes = '';
        socket.setTimeout(3000, () => { socket.destroy(); reject(new Error('Upgrade did not close')); });
        socket.on('connect', () => socket.write(`GET ${target} HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`));
        socket.on('data', (chunk: Buffer) => { bytes += chunk.toString(); });
        socket.on('error', reject); socket.on('end', () => resolve(bytes));
      });
      expect(response).toContain('404');
    }
    expect(await attemptUpgrade(started.url, { Origin: ALLOWED_ORIGIN, Cookie: `${authConfig.cookieName}=${validSessionCookie()}` })).toBe('open');
    expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);
  });

  it('contains an unmasked frame while rejecting a session that expired after authentication', async () => {
    const authenticatedAt = new Date('2026-10-01T12:00:00.000Z');
    const expiredAtConnection = new Date('2026-10-01T12:00:01.000Z');
    const session = { ...validSession, exp: expiredAtConnection.getTime() / 1000 };
    const times = [authenticatedAt, expiredAtConnection];
    app = buildServer(authConfig);
    await app.listen({ port: 0, host: '127.0.0.1' });
    attachWebSocketServer(app.server, app.log, authConfig, undefined, () => times.shift() ?? expiredAtConnection);
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('expected a TCP address');

    await sendUnmaskedFrame(address.port, encodeSession(authConfig, session));

    expect(times).toEqual([]);
    expect((await fetch(`http://127.0.0.1:${address.port}/healthz`)).status).toBe(200);
  });

  it('contains an unmasked frame on an active connection', async () => {
    const started = await startServer();
    app = started.app;
    const port = Number(new URL(started.url).port);

    await sendUnmaskedFrame(port, validSessionCookie());

    expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);
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
