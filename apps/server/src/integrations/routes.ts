import { readToolModeChange } from '@opencrane/models';
import { readIntegrationFacts } from './facts.ts';
import { readCompanyOptIn } from './company-opt-in-read.ts';
import { budgetChange } from '@opencrane/models';
import { readPublication, publicationChange } from '@opencrane/projections';
import { readHostedAdmission, requestHostedCheck } from '@opencrane/models';
import { hostedAdmissionSchema } from '@opencrane/protocol';
import { AuthorityApplying, registerHosted, hostedRegistrationChange } from '@opencrane/models';
import { activeMember, readActiveMember, GroupRefused } from '../members/groups.ts';
import { installWorker } from './install-worker.ts';
import type { RemoteNetwork } from './remote.ts';
import { registerRemote, discoveryStatus, remoteReference } from './registration.ts';
import { createHash } from 'node:crypto';
import { budgetCommandSchema } from '@opencrane/protocol';
import { z } from 'zod';
import type { EventStore } from '@opencrane/event-store';
import { readToolPolicy, setToolPolicy, reviewToolPolicy, publishToolPolicy, models, taskRouting, priceTableId, shortContextTokens, totals, readBudget, budgetSummary } from '@opencrane/models';
import type { Query } from '@opencrane/projections';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { isOrganisationSession, type AuthConfig, type tokenIssuer } from '@opencrane/auth';
import { memberAuthorisation, type Binding } from '@opencrane/authz';
import type { connectMcpCatalogue, connectMemberFeed } from '@opencrane/projections';
import type { IntegrationsResponse } from '@opencrane/protocol';
import { sessionFor } from '../members/routes.ts';

export interface IntegrationOptions {
  silo: string;
  discovery?: RemoteNetwork;
  feed: Pick<Awaited<ReturnType<typeof connectMemberFeed>>, 'memberId'>;
  catalogue: Pick<ReturnType<typeof connectMcpCatalogue>, 'rows' | 'tools'>;
  store?: EventStore;
  binding: Binding;
  now?: () => Date;
  modelDb?: Query;
  budget?: { decisionUrl: string; tokens: Pick<Awaited<ReturnType<typeof tokenIssuer>>, 'budget'> };
}

const budgetChangeParameters = z.object({
  commandId: z.string().regex(/^[\w-]{1,200}$/u),
}).strict();

export function registerIntegrationRoutes(app: FastifyInstance, config: AuthConfig, options?: IntegrationOptions): void {
  if (options?.store && options.discovery) installWorker(app, options.store, options.silo, options.discovery).start();
  const authorisation = options && memberAuthorisation(options.binding);
  const now = options?.now ?? (() => new Date());
  const paths = [
    '/api/org/integrations', '/api/org/models', '/api/org/models/changes/:commandId',
    '/api/org/integrations/:serverId/tools', '/api/org/integrations/:serverId/review',
    '/api/org/integrations/:serverId/publication', '/api/org/integrations/:serverId/discovery',
    '/api/org/integrations/:serverId/admission', '/api/org/integrations/:serverId/checks',
    '/api/org/integrations/discovery', '/api/org/integrations/changes/:commandId',
    '/api/org/integrations/:serverId/company-opt-in',
    '/api/org/integrations/:serverId/facts', '/api/org/integrations/:serverId/changes/:commandId',
  ];
  for (const path of paths) {
    const readOnly = path.endsWith('/discovery') || path.endsWith('/:commandId') ||
      path.endsWith('/admission') || path.endsWith('/facts') || path.endsWith('/company-opt-in');
    let method: ('GET' | 'POST')[] = ['GET', 'POST'];
    if (readOnly) {
      method = ['GET'];
    }
    if (path.endsWith('/checks')) {
      method = ['POST'];
    }
    async function handleIntegration(request: FastifyRequest, reply: FastifyReply) {
      if (path.endsWith('/publication') || path.endsWith('/:commandId') || path.endsWith('/facts')) {
        reply.header('cache-control', 'no-store');
      }
      const session = sessionFor(request, config, now());
      if (!session) return reply.code(401).send({ status: 'refused', reason: 'no_session' });
      if (!options || !authorisation || !config.expectedOrgId) return reply.code(503).send({ status: 'unavailable' });
      if (!isOrganisationSession(config, session)
        || options.silo !== options.binding.silo) {
        return reply.code(403).send({ status: 'refused', reason: 'wrong_silo' });
      }
      try {
        const memberId = await options.feed.memberId(options.silo, config.issuerUrl, session.sub);
        if (!memberId) {
          return reply.code(403).send({ status: 'refused', reason: 'admin_required', requiredRole: 'Owner or Admin' });
        }
        return await checkedIntegrationRequest(path, request, reply, config, options, memberId, now());
      } catch (error) {
        return routeError(request, reply, error);
      }
    }
    function privateReply(_request: FastifyRequest, reply: FastifyReply, done: () => void) {
      reply.header('cache-control', 'no-store');
      done();
    }
    function invalidRead(error: Error & { statusCode?: number },
      _request: FastifyRequest, reply: FastifyReply) {
      if (error.statusCode && error.statusCode >= 400 && error.statusCode < 500) {
        return reply.code(400).send({ status: 'invalid_request' });
      }
      return reply.code(503).send({ status: 'unavailable' });
    }
    if (path.endsWith('/company-opt-in')) {
      app.route({ method, url: path, handler: handleIntegration,
        onRequest: privateReply, errorHandler: invalidRead });
    } else {
      app.route({ method, url: path, handler: handleIntegration });
    }
  }
}

async function checkedIntegrationRequest(path: string, request: FastifyRequest,
  reply: FastifyReply, config: AuthConfig, options: IntegrationOptions,
  memberId: string, now: Date) {
  if (path.endsWith('/company-opt-in')) {
    return readCompanyOptIn(request, reply, options, memberId);
  }
  if (path === '/api/org/integrations/:serverId/changes/:commandId') {
    const id = z.string().regex(/^[\w-]{1,200}$/u);
    const parameters = z.strictObject({ serverId: id, commandId: id });
    const { serverId, commandId } = parameters.parse(request.params);
    z.strictObject({}).parse(request.query);
    if (!options.store) {
      return reply.code(503).send({ status: 'unavailable' });
    }
    const result = await readToolModeChange(options.store, options.binding, memberId,
      serverId, commandId);
    return reply.send(result);
  }
  if (path.endsWith('/facts')) {
    if (!options.store || !options.modelDb) {
      return reply.code(503).send({ status: 'unavailable' });
    }
    const sources = { ...options, store: options.store, db: options.modelDb };
    return readIntegrationFacts(request, reply, sources, memberId);
  }
  const authorisation = memberAuthorisation(options.binding);
  if (path === '/api/org/models/changes/:commandId') {
    const { commandId } = budgetChangeParameters.parse(request.params);
    if (!options.store) return reply.code(503).send({ status: 'unknown' });
    const result = await budgetChange(options.store, options.binding, memberId, commandId);
    return reply.send(result);
  }
  const permission = await authorisation.check(memberId, 'admin');
  if (permission.status === 'unavailable') return reply.code(503).send({ status: 'unavailable' });
  if (!permission.allowed) {
    return reply.code(403).send({ status: 'refused', reason: 'admin_required', requiredRole: 'Owner or Admin' });
  }
  if (options.store) {
    if (request.method === 'GET') {
      await readActiveMember(options.store, options.binding, memberId, 'admin');
    } else {
      const authority = { requiredRole: 'admin' as const };
      await activeMember(options.store, options.binding, memberId, authority);
    }
  }
  return await authorisedRequest(path, request, reply, config, options, memberId, now);
}

async function authorisedRequest(path: string, request: FastifyRequest, reply: FastifyReply, config: AuthConfig, options: IntegrationOptions, memberId: string, now: Date) {
      if (isStatusRead(path, request.method)) {
        return integrationStatus(path, request, reply, options);
      }
      if (path.endsWith('/checks')) {
        return requestImageCheck(request, reply, config, options, memberId);
      }
      if (path.endsWith('/discovery')) {
        if (!options.store) return reply.code(503).send({ status: 'unavailable' });
        const { serverId } = path === '/api/org/integrations/discovery'
          ? remoteReference(options.silo, z.object({ locator: z.string().max(2048) }).parse(request.query).locator)
          : z.object({ serverId: z.string().regex(/^[\w-]{1,200}$/u) }).parse(request.params);
        const status = await discoveryStatus(options.store, options.silo, serverId);
        return reply.code(status ? 200 : 404).send(status ?? { status: 'not_found' });
      }
      if (path === '/api/org/integrations' && request.method === 'POST') {
        return registerIntegration(request, reply, config, options, memberId);
      }
      if (/\/(review|publication)$/u.test(path)) {
        return review(request, reply, config, options, memberId);
      }
      if (path.endsWith('/tools')) {
        return await tools(request, reply, config, options, memberId);
      }
      if (path === '/api/org/models') {
        if (request.method === 'POST') return await setBudget(request, reply, config, options, memberId);
        if (!options.modelDb) return reply.code(503).send({ status: 'unavailable' });
        const state = await readBudget(options.modelDb, options.silo);
        return reply.send({ models, taskRouting, priceTableId, shortContextTokens, ...totals(state, now), budget: budgetSummary(state, now) });
      }
      const response: IntegrationsResponse = { rows: await options.catalogue.rows(options.silo), loadedAt: now.toISOString() };
      return reply.send(response);
 }

function isStatusRead(path: string, method: string) {
  return method === 'GET' && (path.endsWith('/publication') || path.endsWith('/admission') ||
    path.endsWith('/:commandId'));
}

async function publicationStatus(request: FastifyRequest, reply: FastifyReply,
  options: IntegrationOptions) {
  const params = z.object({ serverId: z.string().regex(/^[\w-]{1,200}$/u) });
  const { serverId } = params.parse(request.params);
  if (!options.modelDb || !options.store) {
    return reply.send({ status: 'unknown', stage: 'read', reason: 'unavailable' });
  }
  return reply.send(await readPublication(options.modelDb, options.silo, serverId));
}

async function integrationStatus(path: string, request: FastifyRequest, reply: FastifyReply,
  options: IntegrationOptions) {
  if (path.endsWith('/publication')) return publicationStatus(request, reply, options);
  if (!options.store) return reply.code(503).send({ status: 'unavailable' });
  if (path.endsWith('/:commandId')) {
    const params = z.object({ commandId: z.string().regex(/^[\w-]{1,200}$/u) })
      .parse(request.params);
    let registration: Awaited<ReturnType<typeof hostedRegistrationChange>> | undefined;
    try {
      registration = await hostedRegistrationChange(options.store, options.silo, params.commandId);
    } catch {
      // A failed history read cannot confirm a registration, so check the saved publication too.
    }
    if (registration?.status === 'applied') return reply.send(registration);
    if (options.modelDb) {
      const status = await publicationChange(options.modelDb, options.silo, params.commandId);
      if (status) return reply.send(status);
    }
    if (registration) return reply.send(registration);
    return reply.send({ status: 'unknown', stage: 'read', reason: 'unavailable' });
  }
  const params = z.object({ serverId: z.string().regex(/^[\w-]{1,200}$/u) });
  const { serverId } = params.parse(request.params);
  const admission = await readHostedAdmission(options.store, options.silo, serverId);
  if (!admission) return reply.code(404).send({ status: 'not_found' });
  return reply.send(hostedAdmissionSchema.parse(admission));
}

async function registerIntegration(request: FastifyRequest, reply: FastifyReply,
  config: AuthConfig, options: IntegrationOptions, memberId: string) {
  if (request.headers.origin !== new URL(config.redirectUri).origin) {
    return reply.code(403).send({ status: 'refused' });
  }
  if (!options.store) return reply.code(503).send({ status: 'unavailable' });
  const body = z.object({ kind: z.string().optional() }).parse(request.body);
  if (body.kind === 'hosted') {
    const result = await registerHosted(options.store, options.binding, memberId, request.body);
    let statusCode = 409;
    if (result.status === 'appended') {
      statusCode = 202;
    }
    if (result.status === 'unavailable') {
      statusCode = 503;
    }
    return reply.code(statusCode).send(result);
  }
  const result = await registerRemote(options.store, options.silo, memberId, request.body);
  return reply.code(202).send(result);
}

async function tools(request: FastifyRequest, reply: FastifyReply, config: AuthConfig, options: IntegrationOptions, memberId: string) {
        const { serverId } = z.object({ serverId: z.string().regex(/^[\w-]{1,200}$/u) }).parse(request.params);
        if (request.method === 'GET') return reply.send(await options.catalogue.tools(options.silo, serverId));
        if (request.headers.origin !== new URL(config.redirectUri).origin) return reply.code(403).send({ status: 'refused' });
        if (!options.store) return reply.code(503).send({ status: 'unavailable' });
        const result = await setToolPolicy(options.store, options.binding, memberId, serverId, request.body);
        if (result.status === 'appended' && 'receipt' in result) {
          const policy = await readToolPolicy(options.store, options.silo, serverId);
          const response = { status: result.status, receipt: result.receipt, policy };
          return reply.send(response);
        }
        const statusCode = result.status === 'unavailable' ? 503 : 409;
        const response = { status: result.status };
        return reply.code(statusCode).send(response);
}

async function review(request: FastifyRequest, reply: FastifyReply, config: AuthConfig,
  options: IntegrationOptions, memberId: string) {
  if (request.method !== 'POST') {
    return reply.code(405).send({ status: 'refused' });
  }
  if (request.headers.origin !== new URL(config.redirectUri).origin) {
    return reply.code(403).send({ status: 'refused' });
  }
  if (!options.store) return reply.code(503).send({ status: 'unavailable' });
  const params = z.object({ serverId: z.string().regex(/^[\w-]{1,200}$/u) });
  const { serverId } = params.parse(request.params);
  const command = request.routeOptions.url?.endsWith('/publication') ? publishToolPolicy : reviewToolPolicy;
  const result = await command(options.store, options.binding, memberId, serverId, request.body);
  let statusCode = 409;
  if (result.status === 'appended') {
    statusCode = 200;
  }
  if (result.status === 'unavailable') {
    statusCode = 503;
  }
  const receipt = { status: result.status,
    ...(result.status === 'appended' && 'sequence' in result ? { sequence: result.sequence } : {}),
    ...(result.status === 'appended' && 'receipt' in result ? { receipt: result.receipt } : {}) };
  return reply.code(statusCode).send(receipt);
}

function routeError(request: FastifyRequest, reply: FastifyReply, error: unknown) {
  if (error instanceof AuthorityApplying) {
    return reply.code(503).send({ status: 'unavailable' });
  }
  if (error instanceof GroupRefused) {
    return reply.code(403).send({ status: 'refused' });
  }
      if (error instanceof z.ZodError || error instanceof Error && error.message === 'invalid_endpoint') return reply.code(400).send({ status: 'invalid_request' });
      if (error instanceof Error && error.message === 'Access changed') return reply.code(403).send({ status: 'refused' });
      request.log.error({ operation: 'mcp-catalogue.read' }, 'MCP catalogue unavailable');
      return reply.code(503).send({ status: 'unavailable' });
}

async function setBudget(request: FastifyRequest, reply: FastifyReply, config: AuthConfig, options: IntegrationOptions, memberId: string) {
  if (request.headers.origin !== new URL(config.redirectUri).origin) return reply.code(403).send({ status: 'refused' });
  const command = budgetCommandSchema.parse(request.body);
  if (!options.budget) return reply.code(503).send({ status: 'unavailable' });
  const body = JSON.stringify(command);
  const token = await options.budget.tokens.budget({ silo: options.silo, memberId, commandDigest: createHash('sha256').update(body).digest('hex') });
  const headers = { authorization: `Bearer ${token.value}`, 'content-type': 'application/json' };
  // Never follow a redirect: it would send the budget token and the change to another server.
  const budgetRequest: RequestInit = { method: 'POST', headers, body, redirect: 'manual',
    signal: AbortSignal.timeout(5000) };
  const response = await fetch(`${options.budget.decisionUrl}/budgets`, budgetRequest);
  const raw: unknown = await response.json();
  return reply.code(response.status).send(raw);
}

async function requestImageCheck(request: FastifyRequest, reply: FastifyReply,
  config: AuthConfig, options: IntegrationOptions, memberId: string) {
  if (request.headers.origin !== new URL(config.redirectUri).origin) {
    return reply.code(403).send({ status: 'refused' });
  }
  if (!options.store) return reply.code(503).send({ status: 'unavailable' });
  const params = z.object({ serverId: z.string().regex(/^[\w-]{1,200}$/u) });
  const { serverId } = params.parse(request.params);
  const result = await requestHostedCheck(options.store, options.binding, memberId,
    serverId, request.body);
  let statusCode = 409;
  if (result.status === 'appended') {
    statusCode = 202;
  }
  if (result.status === 'not_found') {
    statusCode = 404;
  }
  if (result.status === 'unavailable') {
    statusCode = 503;
  }
  if (result.status !== 'appended') {
    return reply.code(statusCode).send({ status: result.status });
  }
  return reply.code(statusCode).send(result);
}
