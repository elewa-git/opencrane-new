import { z } from 'zod';
import type { EventStore } from '@opencrane/event-store';
import { readToolPolicy, setToolPolicy, models, taskRouting, priceTableId, shortContextTokens, totals, readBudget } from '@opencrane/models';
import type { Query } from '@opencrane/projections';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { isIdentityAllowed, type AuthConfig } from '@opencrane/auth';
import { memberAuthorisation, type Binding } from '@opencrane/authz';
import type { connectMcpCatalogue, connectMemberFeed } from '@opencrane/projections';
import type { IntegrationsResponse } from '@opencrane/protocol';
import { sessionFor } from '../members/routes.ts';

export interface IntegrationOptions {
  silo: string;
  feed: Pick<Awaited<ReturnType<typeof connectMemberFeed>>, 'memberId'>;
  catalogue: Pick<ReturnType<typeof connectMcpCatalogue>, 'rows' | 'tools'>;
  store?: EventStore;
  binding: Binding;
  now?: () => Date;
  modelDb?: Query;
}

export function registerIntegrationRoutes(app: FastifyInstance, config: AuthConfig, options?: IntegrationOptions): void {
  const authorisation = options && memberAuthorisation(options.binding);
  const now = options?.now ?? (() => new Date());
  for (const path of ['/api/org/integrations', '/api/org/models', '/api/org/integrations/:serverId/tools']) app.route({ method: path.endsWith('/tools') ? ['GET', 'POST'] : ['GET'], url: path, handler: async (request, reply) => {
    const session = sessionFor(request, config, now());
    if (!session) return reply.code(401).send({ status: 'refused', reason: 'no_session' });
    if (!options || !authorisation || !config.expectedOrgId) return reply.code(503).send({ status: 'unavailable' });
    if (!isIdentityAllowed(config, { issuer: config.issuerUrl, subject: session.sub, orgId: session.orgId })
      || options.silo !== options.binding.silo) {
      return reply.code(403).send({ status: 'refused', reason: 'wrong_silo' });
    }
    try {
      const memberId = await options.feed.memberId(options.silo, config.issuerUrl, session.sub);
      if (!memberId) {
        return reply.code(403).send({ status: 'refused', reason: 'admin_required', requiredRole: 'Owner or Admin' });
      }
      const permission = await authorisation.check(memberId, 'admin');
      if (permission.status === 'unavailable') return reply.code(503).send({ status: 'unavailable' });
      if (!permission.allowed) {
        return reply.code(403).send({ status: 'refused', reason: 'admin_required', requiredRole: 'Owner or Admin' });
      }
      if (path.endsWith('/tools')) {
        return await tools(request, reply, config, options, memberId);
      }
      if (path === '/api/org/models') {
        if (!options.modelDb) return reply.code(503).send({ status: 'unavailable' });
        return reply.send({ models, taskRouting, priceTableId, shortContextTokens, ...totals(await readBudget(options.modelDb, options.silo), now()) });
      }
      const response: IntegrationsResponse = { rows: await options.catalogue.rows(options.silo), loadedAt: now().toISOString() };
      return reply.send(response);
    } catch (error) {
      return routeError(request, reply, error);
    }
  } });
}

async function tools(request: FastifyRequest, reply: FastifyReply, config: AuthConfig, options: IntegrationOptions, memberId: string) {
        const { serverId } = z.object({ serverId: z.string().regex(/^[\w-]{1,200}$/u) }).parse(request.params);
        if (request.method === 'GET') return reply.send(await options.catalogue.tools(options.silo, serverId));
        if (request.headers.origin !== new URL(config.redirectUri).origin) return reply.code(403).send({ status: 'refused' });
        if (!options.store) return reply.code(503).send({ status: 'unavailable' });
        const result = await setToolPolicy(options.store, options.binding, memberId, serverId, request.body);
        return reply.code(result.status === 'appended' ? 200 : result.status === 'unavailable' ? 503 : 409).send({ status: result.status, ...(result.status === 'appended' ? { policy: await readToolPolicy(options.store, options.silo, serverId) } : {}) });
}

function routeError(request: FastifyRequest, reply: FastifyReply, error: unknown) {
      if (error instanceof z.ZodError) return reply.code(400).send({ status: 'invalid_request' });
      if (error instanceof Error && error.message === 'Access changed') return reply.code(403).send({ status: 'refused' });
      request.log.error({ operation: 'mcp-catalogue.read' }, 'MCP catalogue unavailable');
      return reply.code(503).send({ status: 'unavailable' });
}
