import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { isOrganisationSession, type AuthConfig } from '@opencrane/auth';
import { MemberAccessRefused, readOwnConnectionProfile, readOwnConnectionChange,
  readOwnSelectionChange }
  from '@opencrane/models';
import { z } from 'zod';
import type { GroupOptions } from '../members/group-routes.ts';
import { sessionFor } from '../members/routes.ts';
import { registerConnectionProfileRevoke } from './profile-revoke-route.ts';
import { registerConnectionSelection } from './selection-route.ts';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/u);
const parameters = z.strictObject({ serverId: id, profileId: id });
const changeParameters = parameters.extend({ changeRef: id });
const selectionParameters = z.strictObject({ serverId: id, changeRef: id });
const emptyQuery = z.strictObject({});

export function registerConnectionProfileRead(app: FastifyInstance, config: AuthConfig,
  options?: GroupOptions) {
  registerConnectionSelection(app, config, options);
  registerConnectionProfileRevoke(app, config, options);
  app.get('/api/my/tools/:serverId/profiles/:profileId', handler);
  app.get('/api/my/tools/:serverId/profiles/:profileId/changes/:changeRef', changeHandler);
  app.get('/api/my/tools/:serverId/selection/changes/:changeRef', selectionHandler);
  async function selectionHandler(request: FastifyRequest, reply: FastifyReply) {
    return read(request, reply, selectionParameters, readOwnSelectionChange);
  }
  async function handler(request: FastifyRequest, reply: FastifyReply) {
    return read(request, reply, parameters, readOwnConnectionProfile);
  }
  async function changeHandler(request: FastifyRequest, reply: FastifyReply) {
    return read(request, reply, changeParameters, readOwnConnectionChange);
  }
  async function read(request: FastifyRequest, reply: FastifyReply,
    schema: typeof parameters | typeof changeParameters | typeof selectionParameters,
    reader: typeof readOwnConnectionProfile | typeof readOwnConnectionChange |
      typeof readOwnSelectionChange) {
    reply.header('cache-control', 'no-store');
    const session = sessionFor(request, config, new Date());
    if (!session) {
      return reply.code(401).send({ status: 'refused' });
    }
    if (!isOrganisationSession(config, session)) {
      return reply.code(403).send({ status: 'refused' });
    }
    if (!options) {
      return reply.code(503).send({ status: 'unavailable' });
    }
    if (options.silo !== options.binding.silo) {
      return reply.code(403).send({ status: 'refused' });
    }
    try {
      const reference = schema.parse(request.params);
      emptyQuery.parse(request.query);
      // Reject body framing too: Fastify does not parse bodies on GET requests.
      const length = request.headers['content-length'];
      if (request.body !== undefined || request.headers['transfer-encoding'] !== undefined ||
          (length !== undefined && length !== '0')) {
        return reply.code(400).send({ status: 'refused' });
      }
      const memberId = await options.feed.memberId(options.silo, config.issuerUrl, session.sub);
      if (!memberId) {
        throw new MemberAccessRefused('Active membership required');
      }
      const metadata = await reader(options.store, options.binding,
        memberId, reference);
      if (!metadata) {
        return reply.code(404).send({ status: 'unknown' });
      }
      return reply.send(metadata);
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
