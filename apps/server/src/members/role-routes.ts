import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { isOrganisationSession, type AuthConfig } from '@opencrane/auth';
import { isAuthorityChanged, MemberAccessRefused } from '@opencrane/models';
import type { GroupOptions } from './group-routes.ts';
import { sessionFor } from './routes.ts';
import { removalCommand, removalStatus, RemovalConflict } from './removal.ts';
import { roleCommand, roleStatus, roleParams, RoleConflict } from './roles.ts';

export function registerRoleRoutes(app: FastifyInstance, config: AuthConfig,
  options?: GroupOptions) {
  const routeOptions = { bodyLimit: 1024, errorHandler: invalidBody };
  app.post('/api/members/:memberId/role', routeOptions, handler);
  app.post('/api/members/:memberId/remove', routeOptions, handler);
  app.get('/api/members/:memberId/changes/:commandId', handler);
  async function handler(request: FastifyRequest, reply: FastifyReply) {
    reply.header('cache-control', 'no-store');
    const session = sessionFor(request, config, new Date());
    if (!session) return reply.code(401).send({ status: 'refused' });
    if (!trustedRequest(request, config, session)) {
      return reply.code(403).send({ status: 'refused' });
    }
    if (!options) return reply.code(503).send({ status: 'unavailable' });
    try {
      if (options.silo !== options.binding.silo) throw new MemberAccessRefused('Wrong silo');
      const actor = await options.feed.memberId(options.silo, config.issuerUrl, session.sub);
      if (!actor) throw new MemberAccessRefused('Active membership required');
      const params = roleParams.parse(request.params);
      let result;
      if (request.method === 'POST') {
        if (request.routeOptions.url?.endsWith('/remove')) {
          result = await removalCommand(options, actor, params.memberId, request.body);
        } else {
          result = await roleCommand(options, actor, params.memberId, request.body);
        }
      } else {
        const commandId = z.string().parse(params.commandId);
        result = await removalStatus(options, actor, params.memberId, commandId);
        result ??= await roleStatus(options, actor, params.memberId, commandId);
      }
      return reply.code(result.status === 'not_found' ? 404 : 200).send(result);
    } catch (error) {
      if (error instanceof z.ZodError) return reply.code(400).send({ status: 'refused' });
      if (error instanceof MemberAccessRefused) return reply.code(403).send({ status: 'refused' });
      const reason = conflictReason(error);
      if (reason) return reply.code(409).send({ status: 'refused', reason });
      request.log.error({ operation: request.routeOptions.url }, 'Member command unavailable');
      return reply.code(503).send({ status: 'unavailable' });
    }
  }
}

function invalidBody(_error: unknown, _request: FastifyRequest, reply: FastifyReply) {
  return reply.header('cache-control', 'no-store').code(400).send({ status: 'refused' });
}

function trustedRequest(request: FastifyRequest, config: AuthConfig,
  session: { orgId: string; sub: string }) {
  if (!isOrganisationSession(config, session)) return false;
  if (request.method !== 'POST') return true;
  return request.headers.origin === new URL(config.redirectUri).origin;
}

function conflictReason(error: unknown) {
  if (error instanceof RoleConflict || error instanceof RemovalConflict) return error.message;
  if (isAuthorityChanged(error)) return 'concurrent_change';
  return undefined;
}
