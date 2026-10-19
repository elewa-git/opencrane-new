import { createHmac } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance, FastifyReply, FastifyRequest, RouteOptions } from 'fastify';
import { isOrganisationSession, type AuthConfig } from '@opencrane/auth';
import { sessionFor } from '../members/routes.ts';
import { isChatRefused, ChatRefused, type ChatOptions } from '../chat/access.ts';
import { controlStatus, requestControl, ControlConflict, RequesterOnly } from './takeover.ts';

const id = z.string().regex(/^[\w-]{1,200}$/u);
const params = z.object({ conversationId: id });
const body = z.object({ commandId: id, requesterEventId: id, generation: z.int().positive() }).strict();
export function registerTakeoverRoutes(app: FastifyInstance, config: AuthConfig,
  options?: ChatOptions, requestsEnabled = false) {
  function register(scope: FastifyInstance, _options: unknown, done: () => void) {
    function rawBody(_request: FastifyRequest, value: string | Buffer,
      parsed: (error: Error | null, value?: unknown) => void) {
      parsed(null, value);
    }
    scope.removeContentTypeParser('application/json');
    scope.addContentTypeParser('application/json', { parseAs: 'string' }, rawBody);
    const route: RouteOptions = { method: ['GET', 'POST'],
      url: '/api/conversations/:conversationId/takeover', bodyLimit: 8192, handler };
    scope.route(route);
    done();
  }
  async function handler(request: FastifyRequest, reply: FastifyReply) {
    reply.header('cache-control', 'no-store');
    const session = sessionFor(request, config, new Date());
    if (!session) return reply.code(401).send({ status: 'refused' });
    if (!options || !config.expectedOrgId) return reply.code(503).send({ status: 'unavailable' });
    if (options.silo !== options.binding.silo || !isOrganisationSession(config, session)) {
      return reply.code(403).send({ status: 'refused' });
    }
    try {
      const { conversationId } = params.parse(request.params);
      const hmac = createHmac('sha256', config.cookieSecret);
      hmac.update(JSON.stringify(['takeover', request.headers.cookie, conversationId]));
      const csrf = hmac.digest('hex');
      let input: z.infer<typeof body> | undefined;
      if (request.method === 'POST') {
        if (request.headers.origin !== new URL(config.redirectUri).origin ||
            request.headers['x-csrf-token'] !== csrf) throw new ChatRefused();
        input = body.parse(JSON.parse(z.string().parse(request.body)));
        if (!requestsEnabled) return reply.code(503).send({ status: 'unavailable' });
      }
      const memberId = await options.feed.memberId(options.silo, config.issuerUrl, session.sub);
      if (!memberId) throw new ChatRefused();
      if (input) {
        const command = { ...input, conversationId };
        const saved = await requestControl(options, memberId, command);
        return reply.code(202).send({ status: saved.phase,
          controlPosition: saved.position, commandId: saved.commandId });
      }
      const status = await controlStatus(options, memberId, conversationId, requestsEnabled);
      return reply.send({ ...status, csrf, serverTime: new Date().toISOString() });
    } catch (error) {
      return routeError(reply, error);
    }
  }
  void app.register(register);
}
function routeError(reply: FastifyReply, error: unknown) {
  if (error instanceof z.ZodError || error instanceof SyntaxError) {
    return reply.code(400).send({ status: 'invalid_request' });
  }
  if (isChatRefused(error)) {
    const reason = error instanceof RequesterOnly ? 'requester_only' : 'access_refused';
    return reply.code(403).send({ status: 'refused', reason });
  }
  if (error instanceof ControlConflict) return reply.code(409).send({ status: 'conflict' });
  return reply.code(503).send({ status: 'unavailable' });
}
