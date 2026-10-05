import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { AuthConfig } from '@opencrane/auth';
import { memberAuthorisation, type Binding } from '@opencrane/authz';
import type { EventStore } from '@opencrane/event-store';
import { auditFilterSchema } from '@opencrane/protocol';
import { readAudit, type Query, type connectMemberFeed } from '@opencrane/projections';
import { currentMembership } from '@opencrane/models';
import { sessionFor } from '../members/routes.ts';

export interface AuditOptions {
  silo: string; store: EventStore; db: Query; binding: Binding;
  feed: Pick<Awaited<ReturnType<typeof connectMemberFeed>>, 'memberId'>;
}
export function registerAuditRoutes(app: FastifyInstance, config: AuthConfig, options?: AuditOptions) {
  for (const url of ['/api/org/history', '/api/conversations/:conversationId/history']) app.get(url, async (request, reply) => {
    const session = sessionFor(request, config, new Date());
    if (!session) return reply.code(401).send({ status: 'refused' });
    if (!options) return reply.code(503).send({ status: 'unavailable' });
    if (session.orgId !== config.expectedOrgId || options.silo !== options.binding.silo) return reply.code(403).send({ status: 'refused' });
    try {
      const filters = auditFilterSchema.parse(request.query);
      const { conversationId } = z.object({ conversationId: z.string().regex(/^[\w-]{1,200}$/u).optional() }).parse(request.params);
      const memberId = await options.feed.memberId(options.silo, config.issuerUrl, session.sub);
      if (!memberId) return reply.code(403).send({ status: 'refused' });
      const result = await readAudit(options.db, options.silo, { ...filters,
        ...(conversationId ? { conversationId, requesterId: memberId } : {}) });
      const allowed = await access(options, memberId, conversationId);
      if (!allowed) return reply.code(403).send({ status: 'refused' });
      return reply.send(result);
    } catch (error) {
      if (error instanceof Error &&
          (error.message === 'Authority changed' ||
           error.message === 'Authority snapshot expired')) {
        return reply.code(403).send({ status: 'refused' });
      }
      if (error instanceof z.ZodError) return reply.code(400).send({ status: 'invalid_request' });
      request.log.error({ operation: 'audit.read' }, 'Audit history unavailable');
      return reply.code(503).send({ status: 'unavailable' });
    }
  });
}
async function access(options: AuditOptions, memberId: string, conversationId?: string) {
  const auth = memberAuthorisation(options.binding);
  const membership = await currentMembership(options.store, options.silo, memberId);
  if (!membership.role || (!conversationId && !['owner', 'admin'].includes(membership.role))) {
    return false;
  }
  for (const row of membership.facts) {
    if (!await auth.applied(row.event.id)) {
      throw new Error('IAM behind');
    }
  }
  const permission = conversationId ? await auth.conversation(memberId, conversationId, 'read') :
    await auth.check(memberId, 'admin');
  if (permission.status === 'unavailable') throw new Error('IAM unavailable');
  return permission.allowed;
}
