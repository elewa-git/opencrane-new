import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { isOrganisationSession, type AuthConfig } from '@opencrane/auth';
import { memberAuthorisation, type Binding } from '@opencrane/authz';
import type { EventStore } from '@opencrane/event-store';
import { auditFilterSchema, auditDetailFilterSchema, type AuditDetailFilter,
  type AuditRow, type AuditRecord } from '@opencrane/protocol';
import { readAudit, readAuditDetail, type Query, type connectMemberFeed } from '@opencrane/projections';
import { currentMembership } from '@opencrane/models';
import { readAccountingProgress } from './accounting-progress.ts';
import { readMembershipProgress } from './membership-progress.ts';
import { sessionFor } from '../members/routes.ts';
import { chatAccess, isChatRefused } from '../chat/access.ts';

export interface AuditOptions {
  silo: string; store: EventStore; db: Query; binding: Binding;
  feed: Pick<Awaited<ReturnType<typeof connectMemberFeed>>, 'memberId'>;
}
export function registerAuditRoutes(app: FastifyInstance, config: AuthConfig, options?: AuditOptions) {
  // Require this organisation even when development sign-in allows named outsiders.
  const organisationConfig = { ...config, extraIdentities: [] };
  for (const url of ['/api/org/history', '/api/conversations/:conversationId/history']) app.get(url, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const session = sessionFor(request, config, new Date());
    if (!session) return reply.code(401).send({ status: 'refused' });
    if (!options) return reply.code(503).send({ status: 'unavailable' });
    if (!isOrganisationSession(organisationConfig, session)
      || options.silo !== options.binding.silo) {
      return reply.code(403).send({ status: 'refused' });
    }
    try {
      const filters = conversationIdFromPath(request.params)
        ? auditFilterSchema.pick({ before: true, requestId: true, turnId: true,
          decision: true }).strict().parse(request.query)
        : auditFilterSchema.parse(request.query);
      const { conversationId } = z.object({ conversationId: z.string().regex(/^[\w-]{1,200}$/u).optional() }).parse(request.params);
      const memberId = await options.feed.memberId(options.silo, config.issuerUrl, session.sub);
      if (!memberId) return reply.code(403).send({ status: 'refused' });
      const query = { ...filters,
        ...(conversationId ? { conversationId, requesterId: memberId, limit: 50 } : {}) };
      const loading = readAudit(options.db, options.silo, query);
      const [loaded] = await Promise.allSettled([loading]);
      // Check access after failed loads too, so errors cannot reveal protected history.
      const allowed = await access(options, memberId, conversationId);
      if (!allowed) return reply.code(403).send({ status: 'refused' });
      if (loaded.status === 'rejected') throw loaded.reason;
      if (conversationId) {
        const rows = loaded.value.rows.map(conversationRow);
        return reply.send({ ...loaded.value, rows });
      }
      const rows = await visibleRows(options, memberId, loaded.value.rows);
      return reply.send({ ...loaded.value, rows });
    } catch (error) {
      if (error instanceof z.ZodError) return reply.code(400).send({ status: 'invalid_request' });
      request.log.error({ operation: 'audit.read' }, 'Audit history unavailable');
      return reply.code(503).send({ status: 'unavailable' });
    }
  });
  app.get('/api/org/history/:auditId', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const session = sessionFor(request, config, new Date());
    if (!session) return reply.code(401).send({ status: 'refused' });
    if (!options) return reply.code(503).send({ status: 'unavailable' });
    if (!isOrganisationSession(organisationConfig, session)
      || options.silo !== options.binding.silo) {
      return reply.code(403).send({ status: 'refused' });
    }
    try {
      const { auditId } = z.object({ auditId: z.string().regex(/^[\w:.-]{1,300}$/u) })
        .parse(request.params);
      const filter = auditDetailFilterSchema.parse(request.query);
      const memberId = await options.feed.memberId(options.silo, config.issuerUrl, session.sub);
      if (!memberId) return reply.code(403).send({ status: 'refused' });
      const loading = loadDetail(options, auditId, filter);
      const [loaded] = await Promise.allSettled([loading]);
      // Check access after failed loads too, so errors cannot reveal a protected record.
      const allowed = await access(options, memberId);
      if (!allowed) return reply.code(403).send({ status: 'refused' });
      if (loaded.status === 'rejected') throw loaded.reason;
      const result = loaded.value;
      if (!result) return reply.code(404).send({ status: 'not_found' });
      const rights = new Map<string, boolean>();
      const records: AuditRecord[] = [];
      for (const record of result.records) {
        records.push(await visiblePublication(options, memberId, record, rights));
      }
      return reply.send({ ...result, records });
    } catch (error) {
      if (error instanceof z.ZodError) return reply.code(400).send({ status: 'invalid_request' });
      request.log.error({ operation: 'audit.detail' }, 'Audit detail unavailable');
      return reply.code(503).send({ status: 'unavailable' });
    }
  });
}
function conversationRow(row: AuditRow): AuditRow {
  const result = { ...row };
  delete result.reservedCents;
  delete result.settledCents;
  result.records = [];
  // Keep money choices and resolver details in the organisation's admin history.
  for (const record of row.records) {
    if (record.type === 'effect.resolved') {
      continue;
    }
    const visible = { ...record };
    delete visible.currentAccounting;
    delete visible.amountCents;
    delete visible.savedOutcome;
    result.records.push(visible);
  }
  return result;
}
async function visibleRows(options: AuditOptions, memberId: string,
  rows: AuditRow[]): Promise<AuditRow[]> {
  const rights = new Map<string, boolean>();
  const visible: AuditRow[] = [];
  for (const row of rows) {
    const records: AuditRecord[] = [];
    for (const record of row.records) {
      records.push(await visiblePublication(options, memberId, record, rights));
    }
    const publication = row.records.find(isChildPublication);
    if (!publication) {
      visible.push({ ...row, records });
      continue;
    }
    const parentAllowed = publication.parentConversationId
      ? rights.get(publication.parentConversationId) : false;
    const childAllowed = publication.childConversationId
      ? rights.get(publication.childConversationId) : false;
    visible.push({ ...row, records,
      conversationId: parentAllowed ? row.conversationId : undefined,
      turnId: childAllowed ? row.turnId : undefined });
  }
  return visible;
}
function isChildPublication(record: AuditRecord): boolean {
  return record.type === 'conversation.child_result_published';
}
async function visiblePublication(options: AuditOptions, memberId: string,
  record: AuditRecord, rights: Map<string, boolean>): Promise<AuditRecord> {
  if (!isChildPublication(record)) return record;
  const visible: AuditRecord = { ...record };
  delete visible.parentConversationId;
  delete visible.childConversationId;
  delete visible.resultEventId;
  delete visible.taskHref;
  const parentId = record.parentConversationId;
  const childId = record.childConversationId;
  const parentAllowed = parentId
    ? await conversationRight(options, memberId, parentId, rights) : false;
  const childAllowed = childId
    ? await conversationRight(options, memberId, childId, rights) : false;
  if (parentId && parentAllowed) {
    visible.parentConversationId = parentId;
    visible.taskHref = `/workspace?conversation=${parentId}`;
  }
  if (childId && childAllowed) {
    visible.childConversationId = childId;
    visible.resultEventId = record.resultEventId;
  }
  if (!parentAllowed && !childAllowed) {
    delete visible.publicationKind;
    delete visible.actor;
  }
  return visible;
}
async function conversationRight(options: AuditOptions, memberId: string,
  conversationId: string, rights: Map<string, boolean>): Promise<boolean> {
  const previous = rights.get(conversationId);
  if (previous !== undefined) return previous;
  try {
    await chatAccess(options, { memberId, conversationId });
    rights.set(conversationId, true);
    return true;
  } catch (error) {
    if (!isChatRefused(error)) throw error;
    rights.set(conversationId, false);
    return false;
  }
}
async function loadDetail(options: AuditOptions, auditId: string, filter: AuditDetailFilter) {
  const result = await readAuditDetail(options.db, options.silo, auditId, filter);
  if (result) {
    await readMembershipProgress(options.db, options.binding, result.records);
    await readAccountingProgress(options.db, options.silo, result.records);
  }
  return result;
}
function conversationIdFromPath(params: unknown): boolean {
  return typeof params === 'object' && params !== null && 'conversationId' in params;
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
