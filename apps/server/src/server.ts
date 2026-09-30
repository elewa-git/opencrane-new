// Builds the Fastify instance. Kept separate from main.ts so tests can
// build a server without binding a real port.
import Fastify, { type FastifyInstance } from 'fastify';

export function buildServer(): FastifyInstance {
  const app = Fastify({ logger: false });

  app.get('/healthz', () => {
    return { status: 'ok' };
  });

  return app;
}
