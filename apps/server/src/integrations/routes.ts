import type { FastifyInstance } from 'fastify';
import type { AuthConfig } from '@opencrane/auth';
import { memberAuthorisation, type Binding } from '@opencrane/authz';
import type { connectMcpCatalogue, connectMemberFeed } from '@opencrane/projections';
import type { IntegrationsResponse } from '@opencrane/protocol';
import { sessionFor } from '../members/routes.ts';

export interface IntegrationOptions {
  silo: string;
  feed: Pick<Awaited<ReturnType<typeof connectMemberFeed>>, 'memberId'>;
  catalogue: Pick<ReturnType<typeof connectMcpCatalogue>, 'rows'>;
  binding: Binding;
  now?: () => Date;
}

export function registerIntegrationRoutes(app: FastifyInstance, config: AuthConfig, options?: IntegrationOptions): void {
  const authorisation = options && memberAuthorisation(options.binding);
  app.get('/api/org/integrations', async (request, reply) => {
    const now = options?.now ?? (() => new Date());
    const session = sessionFor(request, config, now());
    if (!session) return reply.code(401).send({ status: 'refused', reason: 'no_session' });
    if (!options || !authorisation || !config.expectedOrgId) return reply.code(503).send({ status: 'unavailable' });
    if (session.orgId !== config.expectedOrgId || options.silo !== options.binding.silo) {
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
      const response: IntegrationsResponse = { rows: await options.catalogue.rows(options.silo), loadedAt: now().toISOString() };
      return reply.send(response);
    } catch {
      request.log.error({ operation: 'mcp-catalogue.read' }, 'MCP catalogue unavailable');
      return reply.code(503).send({ status: 'unavailable' });
    }
  });
}
