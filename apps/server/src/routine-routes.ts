import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { isOrganisationSession, type AuthConfig } from '@opencrane/auth';
import { MemberAccessRefused } from '@opencrane/models';
import type { GroupOptions } from './members/group-routes.ts';
import { sessionFor } from './members/routes.ts';
import { readRoutineMetadata } from './routine-read.ts';
import { readRoutineRuns, routineRunsQuery } from './routine-runs.ts';
import { ConversationListChanged } from './chat/list-cursor.ts';

const parameters = z.object({ routineId: z.string().regex(/^[\w-]{1,200}$/u) }).strict();

export function registerRoutineReads(app: FastifyInstance, config: AuthConfig,
  options?: GroupOptions) {
  app.get('/api/routines/:routineId', handler);
  app.get('/api/routines/:routineId/runs', handler);
  async function handler(request: FastifyRequest, reply: FastifyReply) {
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
    const parsed = parameters.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({ status: 'refused' });
    }
    const runs = request.routeOptions.url?.endsWith('/runs');
    const query = routineRunsQuery.safeParse(request.query);
    if (runs && !query.success) return reply.code(400).send({ status: 'refused' });
    try {
      const memberId = await options.feed.memberId(options.silo, config.issuerUrl, session.sub);
      if (!memberId) {
        throw new MemberAccessRefused('Active membership required');
      }
      if (runs && query.success) {
        const page = await readRoutineRuns(options, memberId, parsed.data.routineId,
          query.data, config.cookieSecret);
        return reply.send(page);
      }
      const metadata = await readRoutineMetadata(options.store, options.binding,
        memberId, parsed.data.routineId);
      return reply.send(metadata);
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
