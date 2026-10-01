// Attaches a plain `ws` WebSocket server to Fastify's underlying HTTP
// server. We use `ws` directly (no Fastify WebSocket plugin) per the
// Phase 1 task: a tiny Fastify + ws skeleton, nothing more.
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import { URL } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import type { FastifyBaseLogger } from 'fastify';
import { parseEventByType } from '@opencrane/events';
import { decodeSession, parseCookieHeader, type AuthConfig } from '@opencrane/auth';
import {
  errorMessageSchema,
  eventValidationResultSchema,
  helloMessageSchema,
  validateEventMessageSchema,
  type HelloEcho,
} from '@opencrane/protocol';

export const WEBSOCKET_PATH = '/ws';

// Checked during the HTTP upgrade, before the WebSocket handshake
// completes: a request with no valid session cookie gets a plain 401 and
// the socket never opens. `ws`'s `verifyClient` runs synchronously here
// (decodeSession does no I/O), which is what lets it answer before upgrading.
function hasValidSession(authConfig: AuthConfig, req: IncomingMessage): boolean {
  const cookieValue = parseCookieHeader(req.headers.cookie)[authConfig.cookieName];
  if (!cookieValue) {
    return false;
  }
  try {
    decodeSession(authConfig, cookieValue);
    return true;
  } catch {
    return false;
  }
}

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

export function attachWebSocketServer(httpServer: HttpServer, logger: FastifyBaseLogger, authConfig: AuthConfig): WebSocketServer {
  // The session cookie alone is not enough. SameSite=Lax keeps the cookie off
  // requests from other sites, but a sibling subdomain is the same site, so a
  // page there could still open a socket with the person's cookie. plan.md asks
  // for a strict Origin check on the upgrade (cross-site WebSocket hijacking).
  // This slice has one front-end origin: the one the OIDC redirect URI is on.
  // A browser always sends Origin on a WebSocket handshake, so a missing
  // Origin is refused too.
  const allowedOrigin = new URL(authConfig.redirectUri).origin;
  const wss = new WebSocketServer({
    server: httpServer,
    path: WEBSOCKET_PATH,
    verifyClient: (info, callback) => {
      if (info.req.headers.origin !== allowedOrigin) {
        callback(false, 403, 'Forbidden');
        return;
      }
      if (hasValidSession(authConfig, info.req)) {
        callback(true);
      } else {
        callback(false, 401, 'Unauthorized');
      }
    },
  });

  wss.on('connection', (socket: WebSocket) => {
    socket.on('message', (raw: Buffer | ArrayBuffer | Buffer[]) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(toUtf8(raw));
      } catch {
        socket.send(JSON.stringify(errorMessageSchema.parse({ type: 'error', message: 'invalid JSON' })));
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
        // The cross-package path: @opencrane/events binds this event's
        // `type` to the registry and checks `data` against that type's own
        // schema (never the generic z.unknown() placeholder).
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

    socket.on('error', (err: Error) => {
      logger.error({ err }, 'websocket connection error');
    });
  });

  return wss;
}
