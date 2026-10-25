import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { isOrganisationSession, type AuthConfig } from '@opencrane/auth';
import { changePersonalConnection, MemberAccessRefused }
  from '@opencrane/models';
import { z } from 'zod';
import type { GroupOptions } from '../members/group-routes.ts';
import { sessionFor } from '../members/routes.ts';
import { sameOrigin } from '../members/guard.ts';
import { invalidBody } from './instance-routes.ts';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/u);
const parameters = z.strictObject({ serverId: id, profileId: id });
const emptyQuery = z.strictObject({});
const bodySchema = z.strictObject({ changeRef: id, expectedSequence: z.int().nonnegative() });

export function registerConnectionProfileRevoke(app: FastifyInstance, config: AuthConfig,
  options?: GroupOptions) {
  const postOptions = { bodyLimit: 4096, errorHandler: invalidBody };
  app.post('/api/my/tools/:serverId/profiles/:profileId/revoke', postOptions, handler);
  async function handler(request: FastifyRequest, reply: FastifyReply) {
    reply.header('cache-control', 'no-store');
    const session = sessionFor(request, config, new Date());
    if (!session) {
      return reply.code(401).send({ status: 'refused' });
    }
    if (!isOrganisationSession(config, session) || !sameOrigin(request, config)) {
      return reply.code(403).send({ status: 'refused' });
    }
    if (!options) {
      return reply.code(503).send({ status: 'unavailable' });
    }
    if (options.silo !== options.binding.silo) {
      return reply.code(403).send({ status: 'refused' });
    }
    try {
      const reference = parameters.parse(request.params);
      emptyQuery.parse(request.query);
      const body = bodySchema.parse(request.body);
      const memberId = await options.feed.memberId(options.silo, config.issuerUrl, session.sub);
      if (!memberId) {
        throw new MemberAccessRefused('Active membership required');
      }
      const input = { ...reference, ...body, userId: memberId, action: 'revoke' };
      try {
        const receipt = await changePersonalConnection(options.store, options.binding,
          memberId, input);
        return reply.send(receipt);
      } catch (error) {
        if (error instanceof MemberAccessRefused) {
          throw error;
        }
        // Keep command failures private without repeating its permission decision.
        return reply.code(503).send({ status: 'unavailable' });
      }
    } catch (error) {
      if (error instanceof MemberAccessRefused) {
        return reply.code(403).send({ status: 'refused' });
      }
      if (error instanceof z.ZodError) {
        return reply.code(400).send({ status: 'refused' });
      }
      return reply.code(503).send({ status: 'unavailable' });
    }
  }
}
