// Attaches a plain `ws` WebSocket server to Fastify's underlying HTTP
// server. We use `ws` directly (no Fastify WebSocket plugin) per the
// Phase 1 task: a tiny Fastify + ws skeleton, nothing more.
import type { Server as HttpServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { FastifyBaseLogger } from 'fastify';
import { errorMessageSchema, helloMessageSchema, type HelloEcho } from './protocol.ts';

export const WEBSOCKET_PATH = '/ws';

// `ws` hands message payloads back as a Buffer, an ArrayBuffer, or an array
// of Buffers (for a fragmented message); none of those stringify safely
// with the default `.toString()`, so convert them explicitly.
function toUtf8(raw: Buffer | ArrayBuffer | Buffer[]): string {
  if (Array.isArray(raw)) {
    return Buffer.concat(raw).toString('utf8');
  }
  if (Buffer.isBuffer(raw)) {
    return raw.toString('utf8');
  }
  return Buffer.from(raw).toString('utf8');
}

export function attachWebSocketServer(httpServer: HttpServer, logger: FastifyBaseLogger): WebSocketServer {
  const wss = new WebSocketServer({ server: httpServer, path: WEBSOCKET_PATH });

  wss.on('connection', (socket: WebSocket) => {
    socket.on('message', (raw: Buffer | ArrayBuffer | Buffer[]) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(toUtf8(raw));
      } catch {
        socket.send(JSON.stringify(errorMessageSchema.parse({ type: 'error', message: 'invalid JSON' })));
        return;
      }

      const result = helloMessageSchema.safeParse(parsed);
      if (!result.success) {
        socket.send(
          JSON.stringify(errorMessageSchema.parse({ type: 'error', message: 'expected a hello message' })),
        );
        return;
      }

      const echo: HelloEcho = {
        type: 'hello',
        text: result.data.text,
        echoedAt: new Date().toISOString(),
      };
      socket.send(JSON.stringify(echo));
    });

    socket.on('error', (err: Error) => {
      logger.error({ err }, 'websocket connection error');
    });
  });

  return wss;
}
