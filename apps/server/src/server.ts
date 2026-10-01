// Builds the Fastify instance. Kept separate from main.ts so tests can
// build a server without binding a real port.
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { shutdownTelemetry, type LogDestination } from '@opencrane/observability';
import { createServerLogger } from './logging.ts';

export interface BuildServerOptions {
  /** Where log lines go; defaults to stdout. A test passes an in-memory stream to read them back. */
  logDestination?: LogDestination;
}

export function buildServer(options: BuildServerOptions = {}): FastifyInstance {
  // Structured logging via @opencrane/observability: one JSON line per event
  // to stdout, secrets and URL tokens redacted. LOG_LEVEL sets the level
  // (vitest.config.ts sets "silent"). Typed as FastifyBaseLogger so Fastify
  // infers its default generics, matching the plain `FastifyInstance` return.
  const logger: FastifyBaseLogger = createServerLogger(options.logDestination);
  // `request_id` is the name the observability library uses for the request
  // id everywhere else; without this Fastify would call the same value `reqId`.
  const app = Fastify({ loggerInstance: logger, logController: new LogController({ requestIdLogLabel: 'request_id' }) });

  // Flush telemetry when the server closes. A collector that cannot be
  // reached must not make closing the server fail, so the error is logged.
  app.addHook('onClose', async () => {
    await shutdownTelemetry((err) => {
      app.log.error({ err }, 'telemetry shutdown failed');
    });
  });

  app.get('/healthz', () => {
    return { status: 'ok' };
  });

  return app;
}
