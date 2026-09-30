// Builds the Fastify instance. Kept separate from main.ts so tests can
// build a server without binding a real port.
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { createServerLogger } from './logging.ts';

export function buildServer(): FastifyInstance {
  // Structured logging via @opencrane/observability: one JSON line per log
  // event to stdout, sensitive fields redacted, request URLs redacted.
  // LOG_LEVEL lets the level be turned down (vitest.config.ts sets it to
  // "silent" so test runs stay quiet).
  // Typed as FastifyBaseLogger (Fastify's own logger interface, which pino's
  // Logger satisfies) so Fastify infers its default generics, matching this
  // function's plain `FastifyInstance` return type.
  const logger: FastifyBaseLogger = createServerLogger();
  const app = Fastify({ loggerInstance: logger });

  app.get('/healthz', () => {
    return { status: 'ok' };
  });

  return app;
}
