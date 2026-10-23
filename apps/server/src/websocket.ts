import { liveViewPath } from './computers/view.ts';
// Attaches a plain `ws` WebSocket server to Fastify's underlying HTTP
// server. Use `ws` directly because the server only needs to attach its own
// WebSocket routes to Fastify.
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import { URL } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import type { FastifyBaseLogger } from 'fastify';
import { parseEventByType } from '@opencrane/events';
import {
  decodeSession,
  isOrganisationSession,
  parseCookieHeader,
  type AuthConfig,
  type SessionData,
} from '@opencrane/auth';
import {
  subscribeSchema,
  chatSubscribeSchema,
  errorMessageSchema,
  eventValidationResultSchema,
  helloMessageSchema,
  validateEventMessageSchema,
  type HelloEcho,
} from '@opencrane/protocol';

import { conversationSubscription } from './chat/realtime.ts';
import { memberSubscription, type RealtimeOptions } from './realtime.ts';

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

function heartbeat(socket: WebSocket, intervalMs: number) {
  let alive = true;
  function markAlive() {
    alive = true;
  }
  function checkAlive() {
    if (!alive || socket.readyState !== socket.OPEN) {
      socket.terminate();
      return;
    }
    alive = false;
    socket.ping();
  }
  socket.on('pong', markAlive);
  const timer = setInterval(checkAlive, intervalMs);
  timer.unref();
  function stopHeartbeat() {
    clearInterval(timer);
  }
  socket.once('close', stopHeartbeat);
}

export function attachWebSocketServer(
  httpServer: HttpServer,
  logger: FastifyBaseLogger,
  authConfig: AuthConfig,
  realtime?: RealtimeOptions,
  sessionNow: () => Date = () => new Date(),
  heartbeatIntervalMs = 15_000,
): WebSocketServer {
  if (!Number.isSafeInteger(heartbeatIntervalMs) || heartbeatIntervalMs < 1 ||
      heartbeatIntervalMs > 2_147_483_647) {
    throw new Error('WebSocket heartbeat interval must be a positive timer-safe integer');
  }
  // Check the Origin as well as the session cookie. SameSite=Lax blocks other
  // sites, but a sibling subdomain is still the same site and could use the
  // cookie to open a socket. This deployment has one front-end origin, taken
  // from the OIDC redirect URI. Browsers send Origin during the handshake, so
  // refuse requests that omit it too.
  const allowedOrigin = new URL(authConfig.redirectUri).origin;
  const sessions = new WeakMap<IncomingMessage, SessionData>();
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 16 * 1024,
    verifyClient: (info, callback) => {
      if (info.req.headers.origin !== allowedOrigin) {
        callback(false, 403, 'Forbidden');
        return;
      }
      try {
        const cookie = parseCookieHeader(info.req.headers.cookie)[authConfig.cookieName];
        if (!cookie) {
          callback(false, 401, 'Unauthorized');
          return;
        }
        const session = decodeSession(authConfig, cookie, sessionNow());
        if (!isOrganisationSession(authConfig, session)) {
          callback(false, 403, 'Forbidden');
          return;
        }
        sessions.set(info.req, session);
        callback(true);
      } catch {
        callback(false, 401, 'Unauthorized');
      }
    },
  });

  // Separate upgrade owners must not reject each other's paths.
  httpServer.on('upgrade', (request, socket, head) => {
    if (request.url?.split('?')[0] !== WEBSOCKET_PATH) {
      if (!liveViewPath.test(request.url ?? '') || httpServer.listenerCount('upgrade') === 1) socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      return;
    }
    wss.handleUpgrade(request, socket, head, client => wss.emit('connection', client, request));
  });

  const connect = (socket: WebSocket, request: IncomingMessage) => {
    const session = sessions.get(request);
    sessions.delete(request);
    if (!session || session.exp * 1000 <= sessionNow().getTime()) {
      logger.warn({ operation: 'websocket.connect' }, 'websocket session unavailable');
      socket.close(1008, 'session unavailable');
      return;
    }
    const subscribe = memberSubscription(socket, session, authConfig, logger, realtime);
    const chat = conversationSubscription(socket, session, authConfig, realtime?.chat);
    let subscribed = false;
    heartbeat(socket, heartbeatIntervalMs);
    let windowStart = Date.now();
    let messages = 0;
    socket.on('message', (raw: Buffer | ArrayBuffer | Buffer[]) => {
      if (socket.readyState !== socket.OPEN) return;
      if (Date.now() - windowStart >= 1000) { windowStart = Date.now(); messages = 0; }
      if (++messages > 20) {
        // Allow reconnecting after a burst without treating it as lost chat access.
        socket.close(1013, 'rate limit');
        return;
      }
      if (socket.bufferedAmount > 64 * 1024) { socket.close(1013, 'slow consumer'); return; }
      let parsed: unknown;
      try {
        parsed = JSON.parse(toUtf8(raw));
      } catch {
        socket.send(JSON.stringify(errorMessageSchema.parse({ type: 'error', message: 'invalid JSON' })));
        return;
      }

      const conversation = chatSubscribeSchema.safeParse(parsed);
      if (conversation.success) {
        if (subscribed) { socket.close(1008); return; } subscribed = true;
        void chat(conversation.data.conversationId, conversation.data.since, conversation.data.generation).catch(() => socket.close(1011)); return;
      }
      const subscription = subscribeSchema.safeParse(parsed);
      if (subscription.success) {
        if (subscribed) { socket.close(1008); return; } subscribed = true;
        void subscribe(subscription.data.since, subscription.data.generation).catch(() => socket.close(1011, 'members unavailable'));
        return;
      }
      const hello = helloMessageSchema.safeParse(parsed);
      if (hello.success) {
        const echo: HelloEcho = {
          type: 'hello',
          text: hello.data.text,
          echoedAt: new Date().toISOString(),
        };
        socket.send(JSON.stringify(echo));
        return;
      }

      const validateEvent = validateEventMessageSchema.safeParse(parsed);
      if (validateEvent.success) {
        // @opencrane/events checks that `type` is registered and validates
        // `data` with that event's schema, not the generic unknown schema.
        const outcome = parseEventByType(validateEvent.data.event);
        const reply = outcome.success
          ? { type: 'eventValidationResult' as const, valid: true }
          : { type: 'eventValidationResult' as const, valid: false, reason: outcome.reason };
        socket.send(JSON.stringify(eventValidationResultSchema.parse(reply)));
        return;
      }

      socket.send(
        JSON.stringify(
          errorMessageSchema.parse({ type: 'error', message: 'expected a hello or validateEvent message' }),
        ),
      );
    });

  };

  wss.on('connection', (socket: WebSocket, request) => {
    socket.on('error', () => {
      logger.error({ operation: 'websocket.connection' }, 'websocket connection error');
      socket.terminate();
    });
    try {
      connect(socket, request);
    } catch {
      logger.error({ operation: 'websocket.connect' }, 'websocket connection failed');
      socket.close(1011, 'connection failed');
    }
  });

  return wss;
}
