import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { isOrganisationSession, type AuthConfig } from '@opencrane/auth';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
import { memberAuthorisation, type Binding } from '@opencrane/authz';
import { history } from '@opencrane/models';
import { readGroups, type Query, type connectMemberFeed } from '@opencrane/projections';
import { sessionFor } from './routes.ts';
import { readActiveMember, groupCommand, GroupConflict, GroupRefused } from './groups.ts';

export interface GroupOptions {
  silo: string;
  store: EventStore;
  db: Query;
  binding: Binding;
  feed: Pick<Awaited<ReturnType<typeof connectMemberFeed>>, 'memberId'>;
}
export function registerGroupRoutes(
  app: FastifyInstance, config: AuthConfig, options?: GroupOptions,
) {
  app.route({ method: ['GET', 'POST'], url: '/api/groups', bodyLimit: 4096, handler });
  app.route({ method: ['GET', 'POST'], url: '/api/groups/:groupId', bodyLimit: 4096, handler });
  app.get('/api/groups/:groupId/changes/:commandId', handler);
  async function handler(request: FastifyRequest, reply: FastifyReply) {
    reply.header('cache-control', 'no-store');
    const session = sessionFor(request, config, new Date());
    if (!session) return reply.code(401).send({ status: 'refused' });
    if (!options) return reply.code(503).send({ status: 'unavailable' });
    if (!trustedRequest(request, config, options, session)) {
      return reply.code(403).send({ status: 'refused' });
    }
    try {
      const memberId = await options.feed.memberId(options.silo, config.issuerUrl, session.sub);
      if (!memberId) throw new GroupRefused('Active membership required');
      const id = z.string().regex(/^[\w-]{1,200}$/u);
      const parameters = z.object({ groupId: id.optional(), commandId: id.optional() });
      const { groupId, commandId } = parameters.parse(request.params);
      if (request.method === 'GET') return await read(reply, options, memberId, groupId, commandId);
      const body = commandBody(z.record(z.string(), z.unknown()).parse(request.body), groupId);
      const result = await groupCommand(options.store, options.binding, memberId, body);
      return reply.send(result);
    } catch (error) {
      const code = errorCode(error);
      return reply.code(code).send({ status: code === 503 ? 'unavailable' : 'refused' });
    }
  }
}

async function readChange(options: GroupOptions, groupId: string, commandId: string,
  deadline: number) {
  const rows = await history(options.store, `team-${groupId}`, options.silo, deadline);
  function matchesCommand(row: StoredEvent) {
    return row.event.commandId === commandId;
  }
  const row = rows.find(matchesCommand);
  if (!row) return { status: 'not_found' as const };
  const checkpoint = await options.db.query<{ sequence: string }>(
    'SELECT sequence FROM projection_checkpoints WHERE name = $1', ['groups']);
  const contentSequence = Number(checkpoint.rows[0]?.sequence ?? 0);
  const content = contentSequence >= row.sequence ? 'current' : 'applying';
  const applied = await memberAuthorisation(options.binding).applied(row.event.id);
  const iam = applied ? 'current' : 'applying';
  return {
    status: 'appended' as const, groupId, sequence: row.sequence, changeId: row.event.id,
    projection: { content, iam },
  };
}

function trustedRequest(request: FastifyRequest, config: AuthConfig,
  options: GroupOptions, session: { sub: string; orgId: string }) {
  if (!isOrganisationSession(config, session)) return false;
  if (options.silo !== options.binding.silo) return false;
  if (request.method !== 'POST') return true;
  const origin = new URL(config.redirectUri).origin;
  return request.headers.origin === origin;
}

async function read(reply: FastifyReply, options: GroupOptions, memberId: string,
  groupId?: string, commandId?: string) {
  const deadline = performance.now() + 10_000;
  let result;
  if (groupId && commandId) {
    result = await readChange(options, groupId, commandId, deadline);
  } else {
    const rows = await readGroups(options.db, options.silo, groupId);
    result = { rows };
  }
  // Check access after loading so a removal during the read cannot expose the result.
  await readActiveMember(options.store, options.binding, memberId, 'admin');
  return reply.code('status' in result && result.status === 'not_found' ? 404 : 200).send(result);
}

function commandBody(body: Record<string, unknown>, groupId?: string) {
  if (groupId && 'groupId' in body) throw new z.ZodError([]);
  if (!groupId && 'action' in body) throw new z.ZodError([]);
  if (groupId && body['action'] !== 'add' && body['action'] !== 'remove') throw new z.ZodError([]);
  if (groupId) return { ...body, groupId };
  return { ...body, action: 'create' };
}

function errorCode(error: unknown) {
  if (error instanceof z.ZodError) return 400;
  if (error instanceof GroupRefused) return 403;
  if (error instanceof GroupConflict) return 409;
  return 503;
}
