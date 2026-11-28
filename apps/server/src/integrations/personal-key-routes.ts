import { recordIdSchema } from '@opencrane/events';
import { savedAssistantConsent } from '@opencrane/models';
import { invalidBody } from './instance-routes.ts';
import { personalConnectionRefusal, logPersonalConnectionFailure }
  from './personal-connection-failure.ts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { isOrganisationSession, type AuthConfig } from '@opencrane/auth';
import { personalKeyCommandSchema } from '@opencrane/protocol';
import { BearerIdentityRefused, foldConnectionSelection, history, MemberAccessRefused, readToolPolicy,
  requirePersonalConnectionAccess, savePersonalKey } from '@opencrane/models';
import { z } from 'zod';
import type { GroupOptions } from '../members/group-routes.ts';
import { sessionFor } from '../members/routes.ts';
import { sameOrigin } from '../members/guard.ts';

const parameterFields = { serverId: recordIdSchema, profileId: recordIdSchema.optional() };
const parameterObject = z.object(parameterFields);
const parameters = parameterObject.strict();
const emptyQueryFields = {};
const emptyQueryObject = z.object(emptyQueryFields);
const emptyQuery = emptyQueryObject.strict();

export function registerPersonalKeyRoutes(app: FastifyInstance, config: AuthConfig,
  options?: GroupOptions) {
  app.get('/api/my/tools/:serverId/connection', handler);
  const postOptions = { bodyLimit: 8192, errorHandler: invalidKeyBody };
  app.post('/api/my/tools/:serverId/profiles/:profileId/key', postOptions, handler);

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
    if (!sameOriginForWrite(request, config)) {
      reply.code(403);
      const response = personalConnectionRefusal('wrong_origin');
      return reply.send(response);
    }
    if (!options) {
      reply.code(503);
      const response = personalConnectionRefusal('unavailable', 'unavailable');
      return reply.send(response);
    }
    if (options.silo !== options.binding.silo) {
      reply.code(503);
      const response = personalConnectionRefusal('wrong_silo', 'unavailable');
      return reply.send(response);
    }
    try {
      const reference = parameters.parse(request.params);
      emptyQuery.parse(request.query);
      const memberId = await options.feed.memberId(options.silo, config.issuerUrl, session.sub);
      if (!memberId) {
        throw new MemberAccessRefused('Active membership required');
      }
      if (request.method === 'GET') {
        const settings = await readSettings(options, memberId, reference.serverId);
        return reply.send(settings);
      }
      const body = personalKeyCommandSchema.parse(request.body);
      const dependencies = options.personalKeys;
      if (!dependencies || !reference.profileId) {
        reply.code(503);
        const response = personalConnectionRefusal('unavailable', 'unavailable');
        return reply.send(response);
      }
      const { material, ...command } = body;
      const input = { ...command, ...reference, appendUntil: Date.now() + 60_000 };
      const saveInput = { command: input, material };
      const saved = await savePersonalKey(options.store, options.binding, memberId,
        dependencies, saveInput);
      return reply.send(saved);
    } catch (error) {
      return personalKeyFailure(request, reply, error);
    }
  }
}

function personalKeyFailure(request: FastifyRequest, reply: FastifyReply, error: unknown) {
  if (error instanceof MemberAccessRefused) {
    reply.code(403);
    const response = personalConnectionRefusal('access_required');
    return reply.send(response);
  }
  if (error instanceof BearerIdentityRefused) {
    logPersonalConnectionFailure(request, error, 'connection.save');
    reply.code(422);
    const response = personalConnectionRefusal('identity_unverified', 'identity_unverified');
    return reply.send(response);
  }
  if (error instanceof z.ZodError) {
    reply.code(400);
    const response = personalConnectionRefusal('invalid_input');
    return reply.send(response);
  }
  logPersonalConnectionFailure(request, error, 'connection.save');
  reply.code(503);
  const response = personalConnectionRefusal('unavailable', 'unavailable');
  return reply.send(response);
}

function sameOriginForWrite(request: FastifyRequest, config: AuthConfig) {
  return request.method === 'GET' || sameOrigin(request, config);
}

async function readSettings(options: GroupOptions, memberId: string, serverId: string) {
  const rows = await history(options.store, `connection-selection-${memberId}-${serverId}`,
    options.silo, performance.now() + 10_000);
  const policy = await readToolPolicy(options.store, options.silo, serverId);
  await requirePersonalConnectionAccess(options.store, options.binding, memberId, serverId);
  if (policy.accountMode !== 'personal' || !policy.published || !policy.identityTool ||
      !policy.connectionId) {
    throw new Error('Connection server unavailable');
  }
  const selected = foldConnectionSelection(rows);
  return { serverId, connectionId: policy.connectionId, identityTool: policy.identityTool,
    selectionRevision: selected.sequence,
    ...(selected.selected ? { selectedProfileId: selected.selected.profileId } : {}),
    ...savedAssistantConsent(selected.selected) };
}

function invalidKeyBody(error: Error & { statusCode?: number }, _request: FastifyRequest,
  reply: FastifyReply) {
  return invalidBody(error, _request, reply, 'invalid_input');
}
