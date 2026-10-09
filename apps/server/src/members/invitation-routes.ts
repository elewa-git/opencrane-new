import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { isOrganisationSession, type AuthConfig } from '@opencrane/auth';
import { MemberAccessRefused } from '@opencrane/models';
import { invitationCommandSchema, invitationStatusParamsSchema } from '@opencrane/protocol';
import type { InvitationEmailOptions } from './invitation-email.ts';
import { recordMemberRefusal } from './refusals.ts';
import { sessionFor } from './routes.ts';
import { invitationCommand, invitationStatus, invitationChange, InvitationConflict } from './invitations.ts';

export function registerInvitations(app: FastifyInstance, config: AuthConfig,
  options?: InvitationEmailOptions) {
  const routeOptions = { bodyLimit: 1024, errorHandler: requestError };
  const now = options?.now ?? currentTime;
  app.post('/api/invitations', routeOptions, handler);
  app.get('/api/invitations/:memberId/changes/:commandId', handler);
  app.get('/api/members/:memberId/changes/:commandId', handler);
  async function handler(request: FastifyRequest, reply: FastifyReply) {
    reply.header('cache-control', 'no-store');
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
    let actor: string | undefined;
    const input = invitationCommandSchema.safeParse(request.body);
    try {
      if (options.silo !== options.binding.silo) throw new MemberAccessRefused('Wrong silo');
      actor = await options.feed.memberId(options.silo, config.issuerUrl, session.sub);
      if (!actor) throw new MemberAccessRefused('Active membership required');
      let result;
      if (request.method === 'POST') {
        if (!input.success) return invalidBody(input.error, request, reply);
        if (!options.db) throw new Error('Member projection unavailable');
        result = await invitationCommand(
          options.store, options.binding, actor, input.data, options.db, now);
      } else {
        const parsedParams = invitationStatusParamsSchema.safeParse(request.params);
        if (!parsedParams.success) return invalidBody(parsedParams.error, request, reply);
        const params = parsedParams.data;
        const full = request.routeOptions.url === '/api/members/:memberId/changes/:commandId';
        result = await readInvitationStatus(options, actor, params, config.redirectUri, full);
      }
      if (reply.sent) return reply;
      const status = result.status === 'not_found' ? 404 : 200;
      return reply.code(status).send(result);
    } catch (error) {
      if (reply.sent) return reply;
      return invitationFailure(error, request, reply, options, actor, input, now());
    } finally {
      clearTimeout(timer);
    }
  }
}

async function readInvitationStatus(options: InvitationEmailOptions, actor: string,
  params: { memberId: string; commandId: string }, redirectUri: string, full: boolean) {
  if (!full) {
    return invitationStatus(options.store, options.binding,
      actor, params.memberId, params.commandId);
  }
  if (!options.db) {
    throw new Error('Member projection unavailable');
  }
  const origin = new URL(redirectUri).origin;
  return invitationChange(options.store, options.binding,
    actor, params.memberId, params.commandId, options.db, origin);
}

async function invitationFailure(error: unknown, request: FastifyRequest, reply: FastifyReply,
  options: InvitationEmailOptions, actor: string | undefined,
  input: ReturnType<typeof invitationCommandSchema.safeParse>, time: Date) {
  let reason: string | undefined;
  if (error instanceof MemberAccessRefused) {
    reason = 'access_refused';
  } else if (error instanceof InvitationConflict && error.message !== 'command_id_reused') {
    reason = error.message;
  }
  if (request.method !== 'POST' || !actor || !input.success
    || options.silo !== options.binding.silo || !reason) {
    return commandError(error, request, reply);
  }
  const recorded = await recordMemberRefusal(options.store, options.silo,
    actor, 'invite', input.data, reason, time);
  if (reply.sent) {
    return reply;
  }
  const code = error instanceof MemberAccessRefused ? 403 : 409;
  const response = { status: 'refused', reason, recorded };
  return reply.code(code).send(response);
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
