import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { isOrganisationSession, type AuthConfig } from '@opencrane/auth';
import { changeConnectionSelection, MemberAccessRefused, SelectionInputInvalid,
  SelectionConflict } from '@opencrane/models';
import { z } from 'zod';
import type { GroupOptions } from '../members/group-routes.ts';
import { sessionFor } from '../members/routes.ts';
import { sameOrigin } from '../members/guard.ts';
import { invalidBody } from './instance-routes.ts';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/u);
const parameters = z.strictObject({ serverId: id });
const emptyQuery = z.strictObject({});
const fields = { connectionId: id, changeRef: id, expectedSequence: z.int().nonnegative() };
const bodySchema = z.discriminatedUnion('action', [
  z.strictObject({ ...fields, action: z.literal('select'), profileId: id,
    profileRevision: z.int().positive() }),
  z.strictObject({ ...fields, action: z.literal('clear') }),
]);

export function registerConnectionSelection(app: FastifyInstance, config: AuthConfig,
  options?: GroupOptions) {
  const postOptions = { bodyLimit: 4096, errorHandler: invalidBody };
  app.post('/api/my/tools/:serverId/selection', postOptions, handler);
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
      const input = { ...body, ...reference };
      const receipt = await changeConnectionSelection(options.store, options.binding, memberId,
        input, options.loadOAuthConfiguration);
      return reply.send(receipt);
    } catch (error) {
      if (error instanceof MemberAccessRefused) {
        return reply.code(403).send({ status: 'refused' });
      }
      if (error instanceof z.ZodError || error instanceof SelectionInputInvalid) {
        return reply.code(400).send({ status: 'refused' });
      }
      if (error instanceof SelectionConflict) {
        return reply.code(409).send({ status: 'refused' });
      }
      return reply.code(503).send({ status: 'unavailable' });
    }
  }
}
