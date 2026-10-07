import type { FastifyInstance } from 'fastify';
import { isOrganisationSession, type AuthConfig } from '@opencrane/auth';
import { memberAuthorisation, type Binding } from '@opencrane/authz';
import type { connectComputers, connectMemberFeed } from '@opencrane/projections';
import type { ComputersResponse } from '@opencrane/protocol';
import { sessionFor } from '../members/routes.ts';

export interface ComputerOptions {
  silo: string;
  feed: Pick<Awaited<ReturnType<typeof connectMemberFeed>>, 'memberId'>;
  computers: Pick<ReturnType<typeof connectComputers>, 'rows'>;
  binding: Binding;
  now?: () => Date;
}

export function registerComputerRoutes(app: FastifyInstance, config: AuthConfig, options?: ComputerOptions): void {
  const authorisation = options && memberAuthorisation(options.binding);
  app.get('/api/org/computers', async (request, reply) => {
    const now = options?.now ?? (() => new Date());
    const session = sessionFor(request, config, now());
    if (!session) return reply.code(401).send({ status: 'refused', reason: 'no_session' });
    if (!options) return reply.code(503).send({ status: 'unavailable' });
    if (!authorisation) return reply.code(503).send({ status: 'unavailable' });
    if (!config.expectedOrgId) return reply.code(503).send({ status: 'unavailable' });
    if (!isOrganisationSession(config, session)) {
      return reply.code(403).send({ status: 'refused', reason: 'wrong_silo' });
    }
    if (options.silo !== options.binding.silo) {
      return reply.code(403).send({ status: 'refused', reason: 'wrong_silo' });
    }
    try {
      const memberId = await options.feed.memberId(options.silo, config.issuerUrl, session.sub);
      if (!memberId) return reply.code(403).send({ status: 'refused', reason: 'admin_required', requiredRole: 'Owner or Admin' });
      const permission = await authorisation.check(memberId, 'admin');
      if (!permission.allowed) {
        if (permission.status === 'unavailable') return reply.code(503).send({ status: 'unavailable' });
        return reply.code(403).send({ status: 'refused', reason: 'admin_required', requiredRole: 'Owner or Admin' });
      }
      const response: ComputersResponse = {
        rows: await options.computers.rows(options.silo), loadedAt: now().toISOString(),
      };
      return reply.send(response);
    } catch {
      request.log.error({ operation: 'computers.read' }, 'Computers unavailable');
      return reply.code(503).send({ status: 'unavailable' });
    }
  });
}
