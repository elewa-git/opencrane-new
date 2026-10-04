import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AuthConfig } from '@opencrane/auth';
import type { EventStore } from '@opencrane/event-store';
import { memberAuthorisation, type Binding } from '@opencrane/authz';
import { authorityFence, history } from '@opencrane/models';
import { readGroups, type Query, type connectMemberFeed } from '@opencrane/projections';
import { sessionFor } from './routes.ts';
import { activeMember, groupCommand, GroupConflict, GroupRefused } from './groups.ts';

export interface GroupOptions {
  silo: string; store: EventStore; db: Query; binding: Binding;
  feed: Pick<Awaited<ReturnType<typeof connectMemberFeed>>, 'memberId'>;
}
export function registerGroupRoutes(app: FastifyInstance, config: AuthConfig, options?: GroupOptions) {
  app.route({ method: ['GET', 'POST'], url: '/api/groups', bodyLimit: 4096, handler });
  app.route({ method: ['GET', 'POST'], url: '/api/groups/:groupId', bodyLimit: 4096, handler });
  app.get('/api/groups/:groupId/changes/:commandId', handler);
  async function handler(request: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) {
    reply.header('cache-control', 'no-store');
    const session = sessionFor(request, config, new Date());
    if (!session) return reply.code(401).send({ status: 'refused' });
    if (!options) return reply.code(503).send({ status: 'unavailable' });
    if (!trustedRequest(request, config, options, session.orgId)) return reply.code(403).send({ status: 'refused' });
    try {
      const memberId = await options.feed.memberId(options.silo, config.issuerUrl, session.sub);
      if (!memberId) throw new GroupRefused('Active membership required');
      const id = z.string().regex(/^[\w-]{1,200}$/u);
      const { groupId, commandId } = z.object({ groupId: id.optional(), commandId: id.optional() }).parse(request.params);
      if (request.method === 'GET') return await read(reply, options, memberId, groupId, commandId);
      const body = commandBody(z.record(z.string(), z.unknown()).parse(request.body), groupId);
      const result = await groupCommand(options.store, options.binding, memberId, body);
      return reply.send(result);
    } catch (error) {
      const code = error instanceof z.ZodError ? 400 : error instanceof GroupRefused ? 403 : error instanceof GroupConflict ? 409 : 503;
      return reply.code(code).send({ status: code === 503 ? 'unavailable' : 'refused' });
    }
  }
}

async function readChange(options: GroupOptions, groupId: string, commandId: string) {
  const rows = await history(options.store, `team-${groupId}`, options.silo);
  const row = rows.find(r => r.event.commandId === commandId);
  if (!row) return { status: 'not_found' as const };
  const checkpoint = await options.db.query<{ sequence: string }>('SELECT sequence FROM projection_checkpoints WHERE name = $1', ['groups']);
  return { status: 'appended' as const, groupId, sequence: row.sequence, changeId: row.event.id,
    projection: { content: Number(checkpoint.rows[0]?.sequence ?? 0) >= row.sequence ? 'current' : 'applying',
      iam: await memberAuthorisation(options.binding).applied(row.event.id) ? 'current' : 'applying' } };
}

function trustedRequest(request: import('fastify').FastifyRequest, config: AuthConfig, options: GroupOptions, orgId: string | undefined) {
  return Boolean(config.expectedOrgId && orgId === config.expectedOrgId && options.silo === options.binding.silo &&
    (request.method !== 'POST' || request.headers.origin === new URL(config.redirectUri).origin));
}

async function read(reply: import('fastify').FastifyReply, options: GroupOptions, memberId: string, groupId?: string, commandId?: string) {
  const fresh = await authorityFence(options.store, performance.now(), [`member-${memberId}`]);
  await activeMember(options.store, options.binding, memberId, true);
  const result = groupId && commandId ? await readChange(options, groupId, commandId) : { rows: await readGroups(options.db, options.silo, groupId) };
  await fresh();
  return reply.code('status' in result && result.status === 'not_found' ? 404 : 200).send(result);
}

function commandBody(body: Record<string, unknown>, groupId?: string) {
  if (groupId ? 'groupId' in body : 'action' in body) throw new z.ZodError([]);
  if (groupId && body['action'] !== 'add' && body['action'] !== 'remove') throw new z.ZodError([]);
  return groupId ? { ...body, groupId } : { ...body, action: 'create' };
}
