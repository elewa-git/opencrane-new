import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { WebSocket } from 'ws';
import { buildServer } from '../src/server.ts';
import { attachWebSocketServer, WEBSOCKET_PATH } from '../src/websocket.ts';
import type { HelloEcho } from '../src/protocol.ts';

describe('server skeleton', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('GET /healthz returns ok', async () => {
    app = buildServer();
    const response = await app.inject({ method: 'GET', url: '/healthz' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('echoes a typed hello over the WebSocket endpoint', async () => {
    app = buildServer();
    // Port 0 asks the OS for a free ephemeral port, so tests never clash.
    await app.listen({ port: 0, host: '127.0.0.1' });
    attachWebSocketServer(app.server, app.log);

    const address = app.server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected a network address');
    }

    const echo = await new Promise<HelloEcho>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${address.port}${WEBSOCKET_PATH}`);
      socket.on('open', () => {
        socket.send(JSON.stringify({ type: 'hello', text: 'hello, opencrane' }));
      });
      socket.on('message', (data: Buffer) => {
        resolve(JSON.parse(data.toString()) as HelloEcho);
        socket.close();
      });
      socket.on('error', reject);
    });

    expect(echo.type).toBe('hello');
    expect(echo.text).toBe('hello, opencrane');
    expect(() => new Date(echo.echoedAt).toISOString()).not.toThrow();
  });

  it('replies with a typed error for a message that is not a hello', async () => {
    app = buildServer();
    await app.listen({ port: 0, host: '127.0.0.1' });
    attachWebSocketServer(app.server, app.log);

    const address = app.server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected a network address');
    }

    const reply = await new Promise<{ type: string; message: string }>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${address.port}${WEBSOCKET_PATH}`);
      socket.on('open', () => {
        socket.send(JSON.stringify({ type: 'not-hello' }));
      });
      socket.on('message', (data: Buffer) => {
        resolve(JSON.parse(data.toString()) as { type: string; message: string });
        socket.close();
      });
      socket.on('error', reject);
    });

    expect(reply.type).toBe('error');
  });

  it('replies with a typed error for a message that is not valid JSON', async () => {
    app = buildServer();
    await app.listen({ port: 0, host: '127.0.0.1' });
    attachWebSocketServer(app.server, app.log);

    const address = app.server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected a network address');
    }

    const reply = await new Promise<{ type: string; message: string }>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${address.port}${WEBSOCKET_PATH}`);
      socket.on('open', () => {
        // Sent as a raw frame, deliberately bypassing JSON.stringify.
        socket.send('{not json');
      });
      socket.on('message', (data: Buffer) => {
        resolve(JSON.parse(data.toString()) as { type: string; message: string });
        socket.close();
      });
      socket.on('error', reject);
    });

    expect(reply.type).toBe('error');
    expect(reply.message).toBe('invalid JSON');
  });

  it('validates an event through @opencrane/events and accepts a well-formed one', async () => {
    app = buildServer();
    await app.listen({ port: 0, host: '127.0.0.1' });
    attachWebSocketServer(app.server, app.log);

    const address = app.server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected a network address');
    }

    const reply = await new Promise<{ type: string; valid: boolean }>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${address.port}${WEBSOCKET_PATH}`);
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
              // memberId matches the subject's "member-<memberId>" binding
              // (libs/events checks this too, not only the data shape).
              data: { memberId: 'alice', email: 'alice@example.com', displayName: 'Alice', role: 'member' },
            },
          }),
        );
      });
      socket.on('message', (data: Buffer) => {
        resolve(JSON.parse(data.toString()) as { type: string; valid: boolean });
        socket.close();
      });
      socket.on('error', reject);
    });

    expect(reply.type).toBe('eventValidationResult');
    expect(reply.valid).toBe(true);
  });

  it('validates an event through @opencrane/events and rejects an unknown event type', async () => {
    app = buildServer();
    await app.listen({ port: 0, host: '127.0.0.1' });
    attachWebSocketServer(app.server, app.log);

    const address = app.server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected a network address');
    }

    const reply = await new Promise<{ type: string; valid: boolean; reason?: string }>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${address.port}${WEBSOCKET_PATH}`);
      socket.on('open', () => {
        socket.send(
          JSON.stringify({
            type: 'validateEvent',
            event: { id: 'evt_1', type: 'no.such.event', source: 's', time: '2026-09-30T10:00:00.000Z', subject: 's', silo: 'acme', data: {} },
          }),
        );
      });
      socket.on('message', (data: Buffer) => {
        resolve(JSON.parse(data.toString()) as { type: string; valid: boolean; reason?: string });
        socket.close();
      });
      socket.on('error', reject);
    });

    expect(reply.valid).toBe(false);
    expect(reply.reason).toBe('unknown_event_type');
  });
});
