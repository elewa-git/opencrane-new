import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AuthConfig } from '@opencrane/auth';
import { currentMembership, readActiveMember, MemberAccessRefused } from '@opencrane/models';
import { toolAccessExplanationSchema } from '@opencrane/protocol';
import { z } from 'zod';
import { idSchema, MemberRefusal, requireMember, sameOrigin } from '../members/guard.ts';
import type { GroupOptions } from '../members/group-routes.ts';
import { memberInventory } from '../members/inventory.ts';
import { explanationPolicy, explainTool, toolReviewRevision } from './access-explanation.ts';

const parameters = z.object({ serverId: idSchema }).strict();
const query = z.object({ requesterId: idSchema, assistantId: idSchema,
  toolName: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/u) }).strict();

export function registerToolExplanation(app: FastifyInstance, config: AuthConfig,
  options?: GroupOptions) {
  app.get('/api/org/integrations/:serverId/access/explanation', handler);
  async function handler(request: FastifyRequest, reply: FastifyReply) {
    function expire() {
      if (!reply.sent) {
        void reply.code(503).send({ status: 'unavailable' });
      }
    }
    reply.header('cache-control', 'no-store');
    const watchdog = setTimeout(expire, 10_000);
    try {
      const checks = { write: false };
      const caller = await requireMember(request, reply, config, options, checks);
      if (request.headers.origin && !sameOrigin(request, config)) {
        throw new MemberAccessRefused('Wrong origin');
      }
      const { serverId } = parameters.parse(request.params);
      const { requesterId, assistantId, toolName } = query.parse(request.query);
      if (requesterId !== caller.memberId) {
        await readActiveMember(caller.options.store, caller.options.binding, caller.memberId, 'admin');
      }
      const body = await loadExplanation(caller.options, requesterId, serverId,
        assistantId, toolName);
      if (reply.sent) {
        return reply;
      }
      return reply.send(toolAccessExplanationSchema.parse(body));
    } catch (error) {
      if (reply.sent) {
        return reply;
      }
      return sendFailure(reply, error);
    } finally {
      clearTimeout(watchdog);
    }
  }
}

async function loadExplanation(options: GroupOptions, requesterId: string, serverId: string,
  assistantId: string, toolName: string) {
  const deadline = performance.now() + 10_000;
  const target = await currentMembership(options.store, options.silo,
    requesterId, undefined, deadline);
  if (!target.role) {
    throw new MemberAccessRefused('Unknown requester');
  }
  const inventory = await memberInventory(options, requesterId, deadline);
  if (!inventory.assistantIds.includes(assistantId)) {
    if (!inventory.complete) {
      throw new Error('Requester context could not be checked completely');
    }
    throw new MemberAccessRefused('Assistant is outside this requester context');
  }
  const policy = await explanationPolicy(options, serverId, deadline);
  if (!policy.serverId) {
    throw new MemberAccessRefused('Unknown server');
  }
  const explanation = await explainTool(options, inventory, requesterId,
    serverId, assistantId, toolName, policy);
  const sources = [];
  for (const row of inventory.rows) {
    if (row.resourceType !== 'mcp_server' || row.resourceId !== serverId) {
      continue;
    }
    for (const source of row.sources) {
      if (source.granteeKind !== 'assistant' || source.granteeId === assistantId) {
        sources.push(source);
      }
    }
  }
  const unavailableSections = [...inventory.unavailableSections, 'publication'];
  const body = { ...explanation, requesterId, serverId, sources, complete: false,
    unavailableSections, reviewRevision: toolReviewRevision(inventory.reviewRevision, policy) };
  return body;
}

function sendFailure(reply: FastifyReply, error: unknown) {
  if (error instanceof MemberRefusal) {
    return reply.code(error.statusCode).send({ status: error.status });
  }
  if (error instanceof z.ZodError) {
    return reply.code(400).send({ status: 'refused' });
  }
  if (error instanceof MemberAccessRefused ||
      error instanceof Error && error.message === 'Wrong silo') {
    return reply.code(403).send({ status: 'refused' });
  }
  return reply.code(503).send({ status: 'unavailable' });
}
