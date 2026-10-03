// Builds the server's logger: @opencrane/observability's pino factory (JSON to
// stdout, secrets and URL tokens redacted on every line) plus a request
// serializer that keeps a request line to the method, a redacted URL, the host
// and the port. server.test.ts and main.test.ts check the server's own lines.
import { createLogger, redactUrl, type LogDestination, type Logger } from '@opencrane/observability';
import type { FastifyRequest } from 'fastify';

/** Fastify's own default `req` serializer shape, but with the URL's secrets redacted. `socket` can be missing (a request made without a real connection), and a serializer that throws would take the process down, so it is read defensively. */
export function redactedRequestSerializer(req: Pick<FastifyRequest, 'method' | 'url' | 'host'> & { socket?: { remotePort?: number } }): Record<string, unknown> {
  return {
    method: req.method,
    url: /\/history(?:\?|$)/u.test(req.url) ? req.url.split('?')[0]?.replace(/^\/api\/conversations\/[^/]+\/history$/u, '/api/conversations/:conversationId/history') : redactUrl(req.url),
    host: req.host,
    remotePort: req.socket?.remotePort,
  };
}

/** Build the logger apps/server passes to Fastify as `loggerInstance`. The level comes from `LOG_LEVEL` (default `info`); a test passes `destination` to capture the lines. */
export function createServerLogger(destination?: LogDestination): Logger {
  return createLogger('opencrane-server', {
    serializers: { req: redactedRequestSerializer },
    ...(destination !== undefined ? { destination } : {}),
  });
}
