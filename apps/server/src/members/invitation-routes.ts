import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { isOrganisationSession, type AuthConfig } from '@opencrane/auth';
import { MemberAccessRefused } from '@opencrane/models';
import { invitationCommandSchema, invitationStatusParamsSchema } from '@opencrane/protocol';
import type { InvitationEmailOptions } from './invitation-email.ts';
import { sessionFor } from './routes.ts';
import { invitationCommand, invitationStatus, InvitationConflict } from './invitations.ts';

export function registerInvitations(app: FastifyInstance, config: AuthConfig,
  options?: InvitationEmailOptions) {
  const routeOptions = { bodyLimit: 1024, errorHandler: requestError };
  app.post('/api/invitations', routeOptions, handler);
  app.get('/api/invitations/:memberId/changes/:commandId', handler);
  async function handler(request: FastifyRequest, reply: FastifyReply) {
    reply.header('cache-control', 'no-store');
    const now = options?.now ?? currentTime;
    const session = sessionFor(request, config, now());
    if (!session) return reply.code(401).send({ status: 'refused', reason: 'no_session' });
    if (!trustedRequest(request, config, session)) {
      return reply.code(403).send({ status: 'refused', reason: 'wrong_origin_or_organisation' });
    }
    if (!options) return reply.code(503).send({ status: 'unavailable' });
    function expire() {
      if (!reply.sent) void reply.code(503).send({ status: 'unavailable' });
    }
    const timer = setTimeout(expire, 15_000);
    try {
      if (options.silo !== options.binding.silo) throw new MemberAccessRefused('Wrong silo');
      const actor = await options.feed.memberId(options.silo, config.issuerUrl, session.sub);
      if (!actor) throw new MemberAccessRefused('Active membership required');
      let result;
      if (request.method === 'POST') {
        const input = invitationCommandSchema.safeParse(request.body);
        if (!input.success) return invalidBody(input.error, request, reply);
        if (!options.db) throw new Error('Member projection unavailable');
        result = await invitationCommand(
          options.store, options.binding, actor, input.data, options.db, now);
      } else {
        const params = invitationStatusParamsSchema.parse(request.params);
        result = await invitationStatus(options.store, options.binding,
          actor, params.memberId, params.commandId);
      }
      if (reply.sent) return reply;
      const status = result.status === 'not_found' ? 404 : 200;
      return reply.code(status).send(result);
    } catch (error) {
      if (reply.sent) return reply;
      return commandError(error, request, reply);
    } finally {
      clearTimeout(timer);
    }
  }
}

function trustedRequest(request: FastifyRequest, config: AuthConfig,
  session: { orgId: string; sub: string }) {
  if (!isOrganisationSession(config, session) || session.orgId !== config.expectedOrgId) {
    return false;
  }
  if (request.method !== 'POST') {
    return true;
  }
  return request.headers.origin === new URL(config.redirectUri).origin;
}

function invalidBody(_error: unknown, _request: FastifyRequest, reply: FastifyReply) {
  return reply.header('cache-control', 'no-store').code(400).send({
    status: 'refused', reason: 'invalid_request',
  });
}

function currentTime() {
  return new Date();
}

function requestError(error: FastifyError, request: FastifyRequest, reply: FastifyReply) {
  const bodyErrors = [
    'FST_ERR_CTP_BODY_TOO_LARGE',
    'FST_ERR_CTP_INVALID_JSON_BODY',
    'FST_ERR_CTP_EMPTY_JSON_BODY',
    'FST_ERR_CTP_INVALID_MEDIA_TYPE',
  ];
  if (bodyErrors.includes(error.code)) {
    return invalidBody(error, request, reply);
  }
  const diagnostic = { operation: 'member.invited' };
  request.log.error(diagnostic, 'Invitation request unavailable');
  return reply.header('cache-control', 'no-store').code(503).send({ status: 'unavailable' });
}

function commandError(error: unknown, request: FastifyRequest, reply: FastifyReply) {
  if (error instanceof MemberAccessRefused) {
    return reply.code(403).send({ status: 'refused', reason: 'access_refused' });
  }
  if (error instanceof InvitationConflict) {
    return reply.code(409).send({ status: 'refused', reason: error.message });
  }
  const diagnostic = { operation: 'member.invited' };
  request.log.error(diagnostic, 'Invitation command unavailable');
  return reply.code(503).send({ status: 'unavailable' });
}
