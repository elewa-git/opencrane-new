import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { isOrganisationSession, type AuthConfig } from '@opencrane/auth';
import { MemberAccessRefused } from '@opencrane/models';
import { z } from 'zod';
import { personalConnectionNeeds } from '../chat/personal-connection-needs.ts';
import type { GroupOptions } from '../members/group-routes.ts';
import { sessionFor } from '../members/routes.ts';

const querySchema = z.object({ assistantId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/u) }).strict();

export function registerPersonalConnectionNeeds(app: FastifyInstance, config: AuthConfig,
  options?: GroupOptions) {
  app.get('/api/my/tools/needs', handler);
  async function handler(request: FastifyRequest, reply: FastifyReply) {
    reply.header('cache-control', 'no-store');
    const session = sessionFor(request, config, new Date());
    if (!session) return reply.code(401).send({ status: 'refused' });
    if (!isOrganisationSession(config, session) ||
        (options && options.silo !== options.binding.silo)) {
      return reply.code(403).send({ status: 'refused' });
    }
    if (!options) return reply.code(503).send({ status: 'unavailable' });
    try {
      const query = querySchema.parse(request.query);
      const memberId = await options.feed.memberId(options.silo, config.issuerUrl, session.sub);
      if (!memberId) throw new MemberAccessRefused('Active membership required');
      const rows = await personalConnectionNeeds(options, memberId, query.assistantId);
      return reply.send({ rows });
    } catch (error) {
      if (error instanceof z.ZodError) return reply.code(400).send({ status: 'refused' });
      if (error instanceof MemberAccessRefused) return reply.code(403).send({ status: 'refused' });
      request.log.warn({ err: error, operation: 'connection.needs', reason: 'unavailable' },
        'Personal connection needs unavailable');
      return reply.code(503).send({ status: 'unavailable' });
    }
  }
}
