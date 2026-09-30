// Builds the server's logger: @opencrane/observability's pino factory
// (JSON to stdout, sensitive fields redacted, request/trace id on every
// line), plus a request serializer that redacts the URL Fastify logs for
// every incoming request. A previous review found the server logging a
// request URL's token verbatim (e.g. `?token=SECRET123`); this closes that
// gap. See apps/server/test/server.test.ts and
// apps/server/test/main.test.ts for the tests that check it.
import { createLogger, redactUrl, type Logger } from '@opencrane/observability';
import type { FastifyRequest } from 'fastify';

/** Fastify's own default `req` serializer shape, but with the URL's query string redacted before it ever reaches a log line. */
function redactedRequestSerializer(req: FastifyRequest): Record<string, unknown> {
  return {
    method: req.method,
    url: redactUrl(req.url),
    host: req.host,
    remotePort: req.socket.remotePort,
  };
}

/** Build the logger apps/server passes to Fastify as `loggerInstance`. */
export function createServerLogger(): Logger {
  return createLogger('opencrane-server', {
    level: process.env['LOG_LEVEL'] ?? 'info',
    serializers: { req: redactedRequestSerializer },
  });
}
