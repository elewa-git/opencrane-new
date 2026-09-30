// Builds the Fastify instance. Kept separate from main.ts so tests can
// build a server without binding a real port.
import Fastify, { type FastifyInstance } from 'fastify';

export function buildServer(): FastifyInstance {
  // Structured logging: Fastify's built-in pino logger, writing one JSON
  // line per log event to stdout. LOG_LEVEL lets the level be turned down
  // (vitest.config.ts sets it to "silent" so test runs stay quiet).
  const app = Fastify({ logger: { level: process.env['LOG_LEVEL'] ?? 'info' } });

  app.get('/healthz', () => {
    return { status: 'ok' };
  });

  return app;
}
