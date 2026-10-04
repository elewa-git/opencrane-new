import { registerScreenshots } from './computers/screenshots.ts';
import { registerEffectRoutes } from './effects/routes.ts';
import { registerGroupRoutes, type GroupOptions } from './members/group-routes.ts';
import { registerBootstrapRoutes } from './members/bootstrap.ts';
import { registerApprovalRoutes } from './chat/approvals.ts';
import { registerLiveView, type LiveViewOptions } from './computers/view.ts';
import { registerFileRoutes, type FileOptions } from './files/routes.ts';
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
  groups?: GroupOptions;
  audit?: AuditOptions;
  chat?: ChatOptions;
  files?: FileOptions;
  integrations?: IntegrationOptions;
  computers?: ComputerOptions;
  liveView?: LiveViewOptions;
  /** The process entrypoint owns bounded cleanup; embedded servers close telemetry here. */
  processOwnsTelemetry?: boolean;
}

export function buildServer(authConfig: AuthConfig, options: BuildServerOptions = {}): FastifyInstance {
  // Structured logging via @opencrane/observability: one JSON line per event
  // to stdout, secrets redacted and whole URL queries removed. LOG_LEVEL sets the level
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
  // the callback URL's entire query is dropped from logs.
  registerAuthRoutes(app, authConfig);
  registerMemberRoutes(app, authConfig, options.membership);
  registerGroupRoutes(app, authConfig, options.groups);
  registerBootstrapRoutes(app, authConfig, options.membership);
  registerIntegrationRoutes(app, authConfig, options.integrations);
  registerEffectRoutes(app, authConfig, options.integrations);
  registerComputerRoutes(app, authConfig, options.computers);
  registerChatRoutes(app, authConfig, options.chat);
  registerAuditRoutes(app, authConfig, options.audit);
  registerLiveView(app, authConfig, options.liveView);

  registerApprovalRoutes(app, authConfig, options.chat);
  registerFileRoutes(app, authConfig, options.files);
  registerScreenshots(app, authConfig, options.files, options.liveView);

  return app;
}
