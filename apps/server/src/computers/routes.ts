import type { FastifyInstance } from 'fastify';
import { isOrganisationSession, type AuthConfig } from '@opencrane/auth';
import type { Binding } from '@opencrane/authz';
import type { EventStore } from '@opencrane/event-store';
import { readActiveMember, MemberAccessRefused } from '@opencrane/models';
import type { connectComputers, connectMemberFeed } from '@opencrane/projections';
import type { ComputersResponse } from '@opencrane/protocol';
import { sessionFor } from '../members/routes.ts';

export interface ComputerOptions {
  silo: string;
  store: EventStore;
  feed: Pick<Awaited<ReturnType<typeof connectMemberFeed>>, 'memberId'>;
  computers: Pick<ReturnType<typeof connectComputers>, 'rows'>;
  binding: Binding;
  now?: () => Date;
}

export function registerComputerRoutes(app: FastifyInstance, config: AuthConfig, options?: ComputerOptions): void {
  app.get('/api/org/computers', async (request, reply) => {
    const now = options?.now ?? (() => new Date());
    const session = sessionFor(request, config, now());
    if (!session) return reply.code(401).send({ status: 'refused', reason: 'no_session' });
    if (!options) return reply.code(503).send({ status: 'unavailable' });
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
      await readActiveMember(options.store, options.binding, memberId, 'admin');
      const response: ComputersResponse = {
        rows: await options.computers.rows(options.silo), loadedAt: now().toISOString(),
      };
      return reply.send(response);
    } catch (error) {
      if (error instanceof MemberAccessRefused) {
        const refusal = {
          status: 'refused', reason: 'admin_required', requiredRole: 'Owner or Admin',
        };
        return reply.code(403).send(refusal);
      }
      request.log.error({ operation: 'computers.read' }, 'Computers unavailable');
      return reply.code(503).send({ status: 'unavailable' });
    }
  });
}
