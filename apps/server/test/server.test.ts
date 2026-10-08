import { record as asRecord } from './record.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { WebSocket } from 'ws';
import { encodeSession } from '@opencrane/auth';
import { buildServer } from '../src/server.ts';
import { attachWebSocketServer, WEBSOCKET_PATH } from '../src/websocket.ts';
import { helloEchoSchema, errorMessageSchema, eventValidationResultSchema, type HelloEcho } from '@opencrane/protocol';
import { testAuthConfig } from './support/test-auth-config.ts';

// Configure the session's organisation so these tests exercise WebSocket messages.
const authConfig = testAuthConfig({ expectedOrgId: 'org-1' });
const nowSeconds = Math.floor(Date.now() / 1000);
const sessionCookie = encodeSession(authConfig, { sub: 'user-1', orgId: 'org-1', roles: ['member'], authTime: nowSeconds, exp: nowSeconds + 3600 });
// testAuthConfig's redirectUri is https://app.example.test/auth/callback.
const wsHeaders = { Origin: 'https://app.example.test', Cookie: `${authConfig.cookieName}=${sessionCookie}` };

describe('server skeleton', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('GET /healthz returns ok', async () => {
    app = buildServer(authConfig);
    const response = await app.inject({ method: 'GET', url: '/healthz' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('echoes a typed hello over the WebSocket endpoint', async () => {
    app = buildServer(authConfig);
    // Port 0 asks the OS for a free ephemeral port, so tests never clash.
    await app.listen({ port: 0, host: '127.0.0.1' });
    attachWebSocketServer(app.server, app.log, authConfig);

    const address = app.server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected a network address');
    }

    const echo = await new Promise<HelloEcho>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${address.port}${WEBSOCKET_PATH}`, { headers: wsHeaders });
      socket.on('open', () => {
        socket.send(JSON.stringify({ type: 'hello', text: 'hello, opencrane' }));
      });
      socket.on('message', (data: Buffer) => {
        resolve(helloEchoSchema.parse(JSON.parse(data.toString())));
        socket.close();
      });
      socket.on('error', reject);
    });

    expect(echo.type).toBe('hello');
    expect(echo.text).toBe('hello, opencrane');
    expect(() => new Date(echo.echoedAt).toISOString()).not.toThrow();
  });

  it('replies with a typed error for a message that is not a hello', async () => {
    app = buildServer(authConfig);
    await app.listen({ port: 0, host: '127.0.0.1' });
    attachWebSocketServer(app.server, app.log, authConfig);

    const address = app.server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected a network address');
    }

    const reply = await new Promise<{ type: string; message: string }>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${address.port}${WEBSOCKET_PATH}`, { headers: wsHeaders });
      socket.on('open', () => {
        socket.send(JSON.stringify({ type: 'not-hello' }));
      });
      socket.on('message', (data: Buffer) => {
        resolve(errorMessageSchema.parse(JSON.parse(data.toString())));
        socket.close();
      });
      socket.on('error', reject);
    });

    expect(reply.type).toBe('error');
  });

  it('replies with a typed error for a message that is not valid JSON', async () => {
    app = buildServer(authConfig);
    await app.listen({ port: 0, host: '127.0.0.1' });
    attachWebSocketServer(app.server, app.log, authConfig);

    const address = app.server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected a network address');
    }

    const reply = await new Promise<{ type: string; message: string }>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${address.port}${WEBSOCKET_PATH}`, { headers: wsHeaders });
      socket.on('open', () => {
        // Sent as a raw frame, deliberately bypassing JSON.stringify.
        socket.send('{not json');
      });
      socket.on('message', (data: Buffer) => {
        resolve(errorMessageSchema.parse(JSON.parse(data.toString())));
        socket.close();
      });
      socket.on('error', reject);
    });

    expect(reply.type).toBe('error');
    expect(reply.message).toBe('invalid JSON');
  });

  it('validates an event through @opencrane/events and accepts a well-formed one', async () => {
    app = buildServer(authConfig);
    await app.listen({ port: 0, host: '127.0.0.1' });
    attachWebSocketServer(app.server, app.log, authConfig);

    const address = app.server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected a network address');
    }

    const reply = await new Promise<{ type: string; valid: boolean }>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${address.port}${WEBSOCKET_PATH}`, { headers: wsHeaders });
      socket.on('open', () => {
        socket.send(
          JSON.stringify({
            type: 'validateEvent',
            event: {
              id: 'evt_1',
              type: 'member.joined',
              source: 'opencrane-server',
              time: '2026-09-30T10:00:00.000Z',
              subject: 'member-alice',
              silo: 'acme',
              data: { memberId: 'mem_1', email: 'alice@example.com', displayName: 'Alice', role: 'member' },
            },
          }),
        );
      });
      socket.on('message', (data: Buffer) => {
        resolve(eventValidationResultSchema.parse(JSON.parse(data.toString())));
        socket.close();
      });
      socket.on('error', reject);
    });

    expect(reply.type).toBe('eventValidationResult');
    expect(reply.valid).toBe(true);
  });

  it('validates an event through @opencrane/events and rejects an unknown event type', async () => {
    app = buildServer(authConfig);
    await app.listen({ port: 0, host: '127.0.0.1' });
    attachWebSocketServer(app.server, app.log, authConfig);

    const address = app.server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected a network address');
    }

    const reply = await new Promise<{ type: string; valid: boolean; reason?: string | undefined }>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${address.port}${WEBSOCKET_PATH}`, { headers: wsHeaders });
      socket.on('open', () => {
        socket.send(
          JSON.stringify({
            type: 'validateEvent',
            event: { id: 'evt_1', type: 'no.such.event', source: 's', time: '2026-09-30T10:00:00.000Z', subject: 's', silo: 'acme', data: {} },
          }),
        );
      });
      socket.on('message', (data: Buffer) => {
        resolve(eventValidationResultSchema.parse(JSON.parse(data.toString())));
        socket.close();
      });
      socket.on('error', reject);
    });

    expect(reply.valid).toBe(false);
    expect(reply.reason).toBe('unknown_event_type');
  });
});

describe('server logging', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
    vi.unstubAllEnvs();
  });

  /** Build a server that logs to memory at info level (vitest.config.ts turns logging off by default). */
  function loggingServer(): { app: FastifyInstance; text: () => string; lines: () => Record<string, unknown>[] } {
    vi.stubEnv('LOG_LEVEL', 'info');
    const chunks: string[] = [];
    app = buildServer(authConfig, { logDestination: { write: (msg: string) => void chunks.push(msg) } });
    const text = (): string => chunks.join('');
    return { app, text, lines: () => text().split('\n').filter(Boolean).map((line) => asRecord(JSON.parse(line))) };
  }

  it('redacts a token in the url of a request to a route that exists, and names the request id request_id', async () => {
    const logs = loggingServer();

    await logs.app.inject({ method: 'GET', url: '/healthz?token=SECRET_INJECT&keep=1' });

    expect(logs.text()).not.toContain('SECRET_INJECT');
    const incoming = logs.lines().find((line) => line['msg'] === 'incoming request');
    expect(asRecord(incoming?.['req'])['url']).toBe('/healthz');
    expect(incoming?.['request_id']).toBe('req-1');
    expect(incoming?.['reqId']).toBeUndefined();
  });

  it("redacts the token in Fastify's own 'Route ... not found' line for a route that does not exist (found logged verbatim)", async () => {
    const logs = loggingServer();

    const response = await logs.app.inject({ method: 'GET', url: '/nope?token=SECRET_B404&code=SECRET_CODE' });

    expect(response.statusCode).toBe(404);
    expect(logs.text()).not.toMatch(/SECRET_/u);
    expect(logs.lines().some((line) => line['msg'] === 'Route GET:/nope not found')).toBe(true);
  });

  it('redacts a secret carried on an error a route throws', async () => {
    const logs = loggingServer();
    logs.app.get('/boom', () => {
      throw Object.assign(new Error('upstream failed'), { apiKey: 'SECRET_ROUTE_KEY', config: { headers: { authorization: 'Bearer SECRET_ROUTE_AUTH' } } });
    });

    const response = await logs.app.inject({ method: 'GET', url: '/boom?access_token=SECRET_ROUTE_URL' });

    expect(response.statusCode).toBe(500);
    expect(logs.text()).toContain('upstream failed');
    expect(logs.text()).not.toMatch(/SECRET_/u);
  });
});
