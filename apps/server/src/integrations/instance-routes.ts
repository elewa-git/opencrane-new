import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AuthConfig } from '@opencrane/auth';
import { z } from 'zod';
import { MemberAccessRefused, McpInstanceRefused,
  mcpInstanceStatus, mcpInstanceChange, mcpInstanceCommand } from '@opencrane/models';
import { requireMember, MemberRefusal, idSchema } from '../members/guard.ts';
import type { ChatOptions } from '../chat/access.ts';

export type McpInstanceOptions = Omit<ChatOptions, 'keys'>;
const id = idSchema.regex(/^[A-Za-z0-9_-]{1,200}$/u);
const instanceId = idSchema.regex(/^[a-f0-9]{64}$/u);
const instanceParams = z.strictObject({ serverId: id, profileId: id });
const instanceQuery = z.strictObject({ instanceId });
const changeParams = z.strictObject({ changeRef: id });
const changeQuery = instanceParams.extend({ instanceId });
const commandBody = z.strictObject({ changeRef: id, expectedSequence: z.int().nonnegative() });
const instancePath = '/api/my/tools/:serverId/profiles/:profileId/instance';

export function registerMcpInstanceRoutes(app: FastifyInstance, config: AuthConfig,
  options?: McpInstanceOptions) {
  app.get(instancePath, handler);
  app.get('/api/my/tools/changes/:changeRef', handler);
  const postOptions = { bodyLimit: 4096, errorHandler: invalidBody };
  app.post(`${instancePath}/stop`, postOptions, handler);
  app.post(`${instancePath}/wake`, postOptions, handler);

  async function handler(request: FastifyRequest, reply: FastifyReply) {
    reply.header('cache-control', 'no-store');
    try {
      const checks = { write: request.method === 'POST' };
      const context = await requireMember(request, reply, config, options, checks);
      const configured = context.options;
      if (request.routeOptions.url === '/api/my/tools/changes/:changeRef') {
        const reference = changeQuery.parse(request.query);
        const { changeRef } = changeParams.parse(request.params);
        return await mcpInstanceChange(configured.store, configured.binding,
          context.memberId, reference, changeRef);
      }
      const parameters = instanceParams.parse(request.params);
      const query = instanceQuery.parse(request.query);
      const reference = { ...parameters, ...query };
      if (request.method === 'GET') {
        return await mcpInstanceStatus(configured.store, configured.binding,
          context.memberId, reference);
      }
      const body = commandBody.parse(request.body);
      let action: 'stop' | 'wake' = 'stop';
      if (request.routeOptions.url === `${instancePath}/wake`) {
        action = 'wake';
      }
      const command = { ...body, action };
      return await mcpInstanceCommand(configured.store, configured.binding,
        context.memberId, reference, command);
    } catch (error) {
      return instanceError(reply, error);
    }
  }
}

function invalidBody(error: Error & { statusCode?: number }, _request: FastifyRequest,
  reply: FastifyReply) {
  reply.header('cache-control', 'no-store');
  const statusCode = error.statusCode === 413 ? 413 : 400;
  return reply.code(statusCode).send({ status: 'refused' });
}

function instanceError(reply: FastifyReply, error: unknown) {
  if (error instanceof MemberRefusal) {
    return reply.code(error.statusCode).send({ status: error.status });
  }
  if (error instanceof MemberAccessRefused) {
    return reply.code(403).send({ status: 'refused' });
  }
  if (error instanceof z.ZodError) {
    return reply.code(400).send({ status: 'refused' });
  }
  if (error instanceof McpInstanceRefused) {
    if (error.reason === 'reference') {
      // Keep missing and foreign references unknown; neither proves that an operation failed.
      return reply.code(404).send({ status: 'unknown' });
    }
    if (error.reason === 'profile_or_admission_unavailable') {
      return reply.code(409).send({ status: 'refused', reason: error.reason });
    }
    return reply.code(409).send({ status: 'refused' });
  }
  return reply.code(503).send({ status: 'unavailable' });
}
