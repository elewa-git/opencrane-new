import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { isOrganisationSession, type AuthConfig } from '@opencrane/auth';
import { MemberAccessRefused } from '@opencrane/models';
import { ConversationListChanged } from '../chat/list-cursor.ts';
import type { GroupOptions } from '../members/group-routes.ts';
import { sessionFor } from '../members/routes.ts';
import { profileListQuery, readOwnConnectionList } from './profile-list.ts';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/u);
const parameters = z.strictObject({ serverId: id });

function hasGetBody(request: FastifyRequest) {
  const length = request.headers['content-length'];
  return request.body !== undefined || request.headers['transfer-encoding'] !== undefined ||
    (length !== undefined && length !== '0');
}

export function registerConnectionProfileList(app: FastifyInstance, config: AuthConfig,
  options?: GroupOptions) {
  app.get('/api/my/tools/:serverId/profiles', handler);
  async function handler(request: FastifyRequest, reply: FastifyReply) {
    reply.header('cache-control', 'no-store');
    const session = sessionFor(request, config, new Date());
    if (!session) return reply.code(401).send({ status: 'refused' });
    if (!isOrganisationSession(config, session) ||
        (options && options.silo !== options.binding.silo)) {
      return reply.code(403).send({ status: 'refused' });
    }
    if (!options) return reply.code(503).send({ status: 'unavailable' });
    const reference = parameters.safeParse(request.params);
    const query = profileListQuery.safeParse(request.query);
    if (!reference.success || !query.success || hasGetBody(request)) {
      return reply.code(400).send({ status: 'refused' });
    }
    try {
      const memberId = await options.feed.memberId(options.silo, config.issuerUrl, session.sub);
      if (!memberId) throw new MemberAccessRefused('Active membership required');
      const page = await readOwnConnectionList(options, memberId, reference.data.serverId,
        query.data, config.cookieSecret);
      return reply.send(page);
    } catch (error) {
      if (error instanceof MemberAccessRefused) {
        return reply.code(403).send({ status: 'refused' });
      }
      if (error instanceof ConversationListChanged) {
        return reply.code(409).send({ status: 'restart' });
      }
      return reply.code(503).send({ status: 'unavailable' });
    }
  }
}
