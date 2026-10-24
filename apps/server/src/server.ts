import { registerRoutineReads } from './routine-routes.ts';
import { registerTakeoverRoutes } from './computers/takeover-routes.ts';
import { registerChildRoutes } from './chat/child-routes.ts';
import { registerPublicationRoutes } from './chat/publications.ts';
import { registerSurveyRoutes } from './onboarding/routes.ts';
import { registerRoleRoutes } from './members/role-routes.ts';
import { registerInvitationEmail,
  type InvitationEmailOptions } from './members/invitation-email.ts';
import { registerInvitations } from './members/invitation-routes.ts';
import { registerOwnershipRoutes } from './members/ownership-routes.ts';
import { registerMemberReads } from './members/read-routes.ts';
import { registerProviderRoutes, type ProviderOptions } from './providers/routes.ts';
import { registerModelAccessRoutes, type ModelAccessOptions } from './models/access-routes.ts';
import { registerSpending } from './models/spending.ts';
import { registerBudgetChoices } from './models/budget-choices.ts';
import { registerAssistantRoutes } from './assistants/routes.ts';
import { registerScreenshots } from './computers/screenshots.ts';
import { registerEffectRoutes } from './effects/routes.ts';
import { registerGroupRoutes, type GroupOptions } from './members/group-routes.ts';
import { registerBootstrapRoutes } from './members/bootstrap.ts';
import { registerBudgetStopRoutes } from './chat/budget-stops.ts';
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
import { registerMcpInstanceRoutes, type McpInstanceOptions }
  from './integrations/instance-routes.ts';
import { registerMcpInstanceWorkerRoutes } from './integrations/instance-worker.ts';
import { registerComputerRoutes, type ComputerOptions } from './computers/routes.ts';

import { registerAuditRoutes, type AuditOptions } from './audit/routes.ts';
import { registerChatRoutes, type ChatOptions } from './chat/routes.ts';
import { registerMemoryReads } from './memory/routes.ts';
import { registerMemoryMcp } from './memory/mcp.ts';
import { registerMemoryCommands } from './memory/commands-routes.ts';

export interface BuildServerOptions {
  /** Where log lines go; defaults to stdout. A test passes an in-memory stream to read them back. */
  logDestination?: LogDestination;
  membership?: MembershipOptions;
  groups?: GroupOptions;
  memberReads?: GroupOptions;
  invitationEmail?: InvitationEmailOptions;
  ownership?: GroupOptions;
  providers?: ProviderOptions;
  modelAccess?: ModelAccessOptions;
  memory?: import('./memory/access.ts').MemoryOptions;
  audit?: AuditOptions;
  chat?: ChatOptions;
  takeoverRequestsEnabled?: boolean;
  onboarding?: ChatOptions;
  files?: FileOptions;
  integrations?: IntegrationOptions;
  mcpInstances?: McpInstanceOptions;
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
  registerMemberReads(app, authConfig, options.memberReads);
  registerRoutineReads(app, authConfig, options.memberReads);
  registerRoleRoutes(app, authConfig, options.memberReads);
  registerInvitationEmail(app, authConfig, options.invitationEmail);
  registerInvitations(app, authConfig, options.invitationEmail);
  registerOwnershipRoutes(app, authConfig, options.ownership);
  registerProviderRoutes(app, authConfig, options.providers);
  registerModelAccessRoutes(app, authConfig, options.modelAccess);
  registerMemoryReads(app, authConfig, options.memory);
  registerMemoryMcp(app, authConfig, options.memory);
  registerMemoryCommands(app, authConfig, options.memory);

  registerBootstrapRoutes(app, authConfig, options.membership);
  registerIntegrationRoutes(app, authConfig, options.integrations);
  registerBudgetChoices(app, authConfig, options.integrations);
  registerSpending(app, authConfig, options.integrations);
  registerMcpInstanceRoutes(app, authConfig, options.mcpInstances);
  if (options.mcpInstances) {
    const configured = options.mcpInstances;
    registerMcpInstanceWorkerRoutes(app, configured.store, configured.silo);
  }
  registerEffectRoutes(app, authConfig, options.integrations);
  registerComputerRoutes(app, authConfig, options.computers);
  registerChatRoutes(app, authConfig, options.chat);
  registerTakeoverRoutes(app, authConfig, options.chat, options.takeoverRequestsEnabled);
  registerPublicationRoutes(app, authConfig, options.chat);
  registerChildRoutes(app, authConfig, options.chat);
  registerSurveyRoutes(app, authConfig, options.onboarding);
  registerAssistantRoutes(app, authConfig, options.chat);
  registerAuditRoutes(app, authConfig, options.audit);
  registerLiveView(app, authConfig, options.liveView);

  registerApprovalRoutes(app, authConfig, options.chat);
  registerBudgetStopRoutes(app, authConfig, options.chat);
  registerFileRoutes(app, authConfig, options.files);
  registerScreenshots(app, authConfig, options.files, options.liveView);

  return app;
}

// Keep production requests off until return and recovery are available.
export function buildProductionServer(config: AuthConfig, options: BuildServerOptions) {
  const productionOptions = { ...options, takeoverRequestsEnabled: false };
  return buildServer(config, productionOptions);
}
