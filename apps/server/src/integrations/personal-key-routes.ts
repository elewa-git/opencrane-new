import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { isOrganisationSession, type AuthConfig } from '@opencrane/auth';
import { personalKeyCommandSchema } from '@opencrane/protocol';
import { BearerIdentityRefused, foldConnectionSelection, history, MemberAccessRefused, readToolPolicy,
  requirePersonalConnectionAccess, savePersonalKey } from '@opencrane/models';
import { z } from 'zod';
import type { GroupOptions } from '../members/group-routes.ts';
import { sessionFor } from '../members/routes.ts';
import { sameOrigin } from '../members/guard.ts';
import { invalidBody } from './instance-routes.ts';

const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/u);
const parameters = z.object({ serverId: identifier, profileId: identifier.optional() }).strict();
const emptyQuery = z.object({}).strict();

export function registerPersonalKeyRoutes(app: FastifyInstance, config: AuthConfig,
  options?: GroupOptions) {
  app.get('/api/my/tools/:serverId/connection', handler);
  const postOptions = { bodyLimit: 8192, errorHandler: invalidBody };
  app.post('/api/my/tools/:serverId/profiles/:profileId/key', postOptions, handler);

  async function handler(request: FastifyRequest, reply: FastifyReply) {
    reply.header('cache-control', 'no-store');
    const session = sessionFor(request, config, new Date());
    if (!session) return reply.code(401).send({ status: 'refused' });
    if (!isOrganisationSession(config, session) || !sameOriginForWrite(request, config)) {
      return reply.code(403).send({ status: 'refused' });
    }
    if (!options || options.silo !== options.binding.silo) {
      return reply.code(503).send({ status: 'unavailable' });
    }
    try {
      const reference = parameters.parse(request.params);
      emptyQuery.parse(request.query);
      const memberId = await options.feed.memberId(options.silo, config.issuerUrl, session.sub);
      if (!memberId) throw new MemberAccessRefused('Active membership required');
      if (request.method === 'GET') {
        const settings = await readSettings(options, memberId, reference.serverId);
        return reply.send(settings);
      }
      const body = personalKeyCommandSchema.parse(request.body);
      const dependencies = options.personalKeys;
      if (!dependencies || !reference.profileId) {
        return reply.code(503).send({ status: 'unavailable' });
      }
      const { material, ...command } = body;
      const input = { ...command, ...reference, appendUntil: Date.now() + 60_000 };
      const saved = await savePersonalKey(options.store, options.binding, memberId,
        dependencies, { command: input, material });
      return reply.send(saved);
    } catch (error) {
      if (error instanceof MemberAccessRefused) {
        return reply.code(403).send({ status: 'refused' });
      }
      if (error instanceof BearerIdentityRefused) {
        return reply.code(422).send({ status: 'identity_unverified' });
      }
      if (error instanceof z.ZodError) return reply.code(400).send({ status: 'refused' });
      logSaveFailure(request, error);
      return reply.code(503).send({ status: 'unavailable' });
    }
  }
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
      !policy.connectionId) throw new Error('Connection server unavailable');
  const selected = foldConnectionSelection(rows);
  return { serverId, connectionId: policy.connectionId, identityTool: policy.identityTool,
    selectionRevision: selected.sequence };
}

function logSaveFailure(request: FastifyRequest, error: unknown) {
  // Keep diagnostic types without logging transport messages that can contain key material.
  const errorType = error instanceof Error ? error.constructor.name : typeof error;
  let causeType: string | undefined;
  if (error instanceof Error && error.cause instanceof Error) {
    causeType = error.cause.constructor.name;
  }
  request.log.warn({ errorType, causeType, operation: 'connection.save', reason: 'unavailable' },
    'Personal connection unavailable');
}
