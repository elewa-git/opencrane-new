import { recordIdSchema } from '@opencrane/events';
import { personalConnectionRefusal, logPersonalConnectionFailure }
  from './personal-connection-failure.ts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { isOrganisationSession, type AuthConfig } from '@opencrane/auth';
import { MemberAccessRefused } from '@opencrane/models';
import { z } from 'zod';
import { personalConnectionNeeds } from '../chat/personal-connection-needs.ts';
import type { GroupOptions } from '../members/group-routes.ts';
import { sessionFor } from '../members/routes.ts';

const queryFields = { assistantId: recordIdSchema };
const queryObject = z.object(queryFields);
const querySchema = queryObject.strict();

export function registerPersonalConnectionNeeds(app: FastifyInstance, config: AuthConfig,
  options?: GroupOptions) {
  app.get('/api/my/tools/needs', handler);
  async function handler(request: FastifyRequest, reply: FastifyReply) {
    reply.header('cache-control', 'no-store');
    const session = sessionFor(request, config, new Date());
    if (!session) {
      reply.code(401);
      const response = personalConnectionRefusal('no_session');
      return reply.send(response);
    }
    if (!isOrganisationSession(config, session)) {
      reply.code(403);
      const response = personalConnectionRefusal('wrong_organisation');
      return reply.send(response);
    }
    if (options && options.silo !== options.binding.silo) {
      reply.code(403);
      const response = personalConnectionRefusal('wrong_silo');
      return reply.send(response);
    }
    if (!options) {
      reply.code(503);
      const response = personalConnectionRefusal('unavailable', 'unavailable');
      return reply.send(response);
    }
    try {
      const query = querySchema.parse(request.query);
      const memberId = await options.feed.memberId(options.silo, config.issuerUrl, session.sub);
      if (!memberId) {
        throw new MemberAccessRefused('Active membership required');
      }
      const rows = await personalConnectionNeeds(options, memberId, query.assistantId);
      const response = { rows };
      return reply.send(response);
    } catch (error) {
      if (error instanceof z.ZodError) {
        reply.code(400);
        const response = personalConnectionRefusal('invalid_input');
        return reply.send(response);
      }
      if (error instanceof MemberAccessRefused) {
        reply.code(403);
        const response = personalConnectionRefusal('access_required');
        return reply.send(response);
      }
      logPersonalConnectionFailure(request, error, 'connection.needs');
      reply.code(503);
      const response = personalConnectionRefusal('unavailable', 'unavailable');
      return reply.send(response);
    }
  }
}
