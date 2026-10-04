import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { AuthConfig } from '@opencrane/auth';
import { memberAuthorisation, type Binding } from '@opencrane/authz';
import type { EventStore } from '@opencrane/event-store';
import { auditFilterSchema } from '@opencrane/protocol';
import { readAudit, type Query, type connectMemberFeed } from '@opencrane/projections';
import { history } from '@opencrane/models';
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
      const allowed = await access(options, memberId, conversationId);
      if (!allowed) return reply.code(403).send({ status: 'refused' });
      const result = await readAudit(options.db, options.silo, { ...filters,
        ...(conversationId ? { conversationId, requesterId: memberId } : {}) });
      // Refuse if the relevant authority changed during the read. No global-history scan.
      if (!(await allowed())) return reply.code(403).send({ status: 'refused' });
      return reply.send(result);
    } catch (error) {
      if (error instanceof z.ZodError) return reply.code(400).send({ status: 'invalid_request' });
      request.log.error({ operation: 'audit.read' }, 'Audit history unavailable');
      return reply.code(503).send({ status: 'unavailable' });
    }
  });
}
async function access(options: AuditOptions, memberId: string, conversationId?: string) {
  const started = performance.now(), auth = memberAuthorisation(options.binding);
  const subjects = [`member-${memberId}`, ...(conversationId ? [`conversation-${conversationId}`] : [])];
  const heads = await Promise.all(subjects.map(subject => options.store.head(subject)));
  const members = await history(options.store, subjects[0]!, options.silo);
  let role: string | undefined;
  for (const row of members) {
    const d = z.record(z.string(), z.unknown()).parse(row.event.data);
    if ((row.event.type === 'member.joined' || row.event.type === 'silo.owner_bootstrapped')) role = z.string().parse(d['role']);
    if (row.event.type === 'member.role_changed') role = z.string().parse(d['newRole']);
    if (row.event.type === 'member.removed') role = undefined;
  }
  if (!role || (!conversationId && !['owner', 'admin'].includes(role))) return undefined;
  const facts = members.filter(row => ['member.joined', 'silo.owner_bootstrapped', 'member.role_changed', 'member.removed'].includes(row.event.type));
  if (conversationId) {
    const conversation = await history(options.store, subjects[1]!, options.silo);
    facts.push(...conversation.filter(row => ['conversation.created', 'participant.added', 'participant.removed'].includes(row.event.type)));
  }
  if (!(await Promise.all(facts.map(row => auth.applied(row.event.id)))).every(Boolean)) throw new Error('IAM behind');
  const permission = conversationId ? await auth.conversation(memberId, conversationId, 'read') : await auth.check(memberId, 'admin');
  if (permission.status === 'unavailable') throw new Error('IAM unavailable');
  if (!permission.allowed) return undefined;
  return async () => {
    const current = await Promise.all(subjects.map(subject => options.store.head(subject)));
    return performance.now() - started <= 2000 && current.every((head, index) => head === heads[index]);
  };
}
