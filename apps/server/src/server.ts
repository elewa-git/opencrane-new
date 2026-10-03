// Builds the Fastify instance. Kept separate from main.ts so tests can
// build a server without binding a real port.
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { AuthConfig } from '@opencrane/auth';
import { shutdownTelemetry, type LogDestination } from '@opencrane/observability';
import { registerAuthRoutes } from './auth/routes.ts';
import { createServerLogger } from './logging.ts';
import { registerMemberRoutes, type MembershipOptions } from './members/routes.ts';
import { registerIntegrationRoutes, type IntegrationOptions } from './integrations/routes.ts';
import { registerComputerRoutes, type ComputerOptions } from './computers/routes.ts';

import { registerAuditRoutes, type AuditOptions } from './audit/routes.ts';
import { registerChatRoutes, type ChatOptions } from './chat/routes.ts';

export interface BuildServerOptions {
  /** Where log lines go; defaults to stdout. A test passes an in-memory stream to read them back. */
  logDestination?: LogDestination;
  membership?: MembershipOptions;
  audit?: AuditOptions;
  chat?: ChatOptions;
  integrations?: IntegrationOptions;
  computers?: ComputerOptions;
  /** The process entrypoint owns bounded cleanup; embedded servers close telemetry here. */
  processOwnsTelemetry?: boolean;
}

export function buildServer(authConfig: AuthConfig, options: BuildServerOptions = {}): FastifyInstance {
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
  if (!options.processOwnsTelemetry) app.addHook('onClose', async () => {
    await shutdownTelemetry((err) => {
      app.log.error({ err }, 'telemetry shutdown failed');
    });
  });

  app.get('/healthz', () => {
    return { status: 'ok' };
  });

  // The auth routes log through app.log, the observability logger above, so
  // the callback URL's `code` and `state` are redacted like any other secret.
  registerAuthRoutes(app, authConfig);
  registerMemberRoutes(app, authConfig, options.membership);
  registerIntegrationRoutes(app, authConfig, options.integrations);
  registerComputerRoutes(app, authConfig, options.computers);
  registerChatRoutes(app, authConfig, options.chat);
  registerAuditRoutes(app, authConfig, options.audit);

  return app;
}
