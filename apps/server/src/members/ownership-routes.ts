import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuthConfig } from '@opencrane/auth';
import { memberAuthorisation } from '@opencrane/authz';
import type { StoredEvent } from '@opencrane/event-store';
import { authorityFence, history, ownershipSubject } from '@opencrane/models';
import type { GroupOptions } from './group-routes.ts';
import { sessionFor } from './routes.ts';
import { ownershipAccess, ownershipStatusAccess, ownershipCommand, ownershipReceipt,
  OwnershipConflict, OwnershipRefused } from './ownership.ts';

export function registerOwnershipRoutes(app: FastifyInstance, config: AuthConfig,
  options?: GroupOptions) {
  app.route({ method: ['GET', 'POST'], url: '/api/ownership', bodyLimit: 4096, handler });
  app.get('/api/ownership/changes/:commandId', handler);
  async function handler(request: FastifyRequest, reply: FastifyReply) {
    reply.header('cache-control', 'no-store');
    const session = sessionFor(request, config, new Date());
    if (!session) {
      return reply.code(401).send({ status: 'refused' });
    }
    if (!options) {
      return reply.code(503).send({ status: 'unavailable' });
    }
    const origin = new URL(config.redirectUri).origin;
    if (!config.expectedOrgId || session.orgId !== config.expectedOrgId ||
        options.silo !== options.binding.silo ||
        (request.method === 'POST' && request.headers.origin !== origin)) {
      return reply.code(403).send({ status: 'refused' });
    }
    try {
      const memberId = await options.feed.memberId(options.silo, config.issuerUrl, session.sub);
      if (!memberId) {
        throw new OwnershipRefused('active_membership_required');
      }
      if (request.method === 'POST') {
        const result = await ownershipCommand(
          options.store, options.binding, memberId, request.body);
        return reply.send(result);
      }
      const parameters = z.object({ commandId: z.string().regex(/^[\w-]{1,200}$/u).optional() });
      const { commandId } = parameters.parse(request.params);
      const result = await read(options, memberId, commandId);
      const code = result.status === 'not_found' ? 404 : 200;
      return reply.code(code).send(result);
    } catch (error) {
      return failure(reply, error);
    }
  }
}
async function read(options: GroupOptions, actorId: string, commandId?: string) {
  const fresh = await authorityFence(options.store, performance.now());
  const access = commandId === undefined ? ownershipAccess : ownershipStatusAccess;
  const membership = await access(options.store, options.binding, actorId, fresh);
  let result;
  if (commandId) {
    result = await readChange(options, commandId, fresh.deadline);
  } else {
    const ownerIds = [...membership.owners];
    ownerIds.sort();
    const owners = [];
    for (const memberId of ownerIds) {
      const rows = await history(options.store, `member-${memberId}`, options.silo, fresh.deadline);
      fresh.include(`member-${memberId}`);
      const joined = rows.findLast(isJoined);
      const fields = z.object({ displayName: z.string() }).parse(joined?.event.data);
      owners.push({ memberId, displayName: fields.displayName, role: 'owner' as const });
    }
    result = { status: 'current', owners, sequence: membership.ownership.at(-1)?.sequence ?? 0,
      viewer: { memberId: actorId, role: membership.role },
      ready: membership.ownership.length > 0 };
  }
  await fresh();
  return result;
}
function isJoined(row: StoredEvent) {
  return ['member.joined', 'silo.owner_bootstrapped'].includes(row.event.type);
}
async function readChange(options: GroupOptions, commandId: string, deadline: number) {
  const rows = await history(options.store, ownershipSubject(options.silo), options.silo, deadline);
  function matchesCommand(row: StoredEvent) {
    return row.event.commandId === commandId && row.event.type !== 'ownership.seeded';
  }
  const row = rows.find(matchesCommand);
  if (!row) {
    return { status: 'not_found' };
  }
  const checkpoint = await options.db.query<{ sequence: string }>(
    'SELECT sequence FROM projection_checkpoints WHERE name = $1', ['members']);
  const contentSequence = Number(checkpoint.rows[0]?.sequence ?? 0);
  const content = contentSequence >= row.sequence ? 'current' : 'applying';
  const applied = await memberAuthorisation(options.binding).applied(row.event.id);
  const iam = applied ? 'current' : 'applying';
  return { ...ownershipReceipt(row), projection: { content, iam } };
}
function failure(reply: FastifyReply, error: unknown) {
  if (error instanceof z.ZodError) {
    return reply.code(400).send({ status: 'refused' });
  }
  if (error instanceof OwnershipRefused) {
    return reply.code(403).send({ status: 'refused', reason: error.message });
  }
  if (error instanceof Error && error.message === 'Authority changed') {
    return reply.code(409).send({ status: 'refused', reason: 'concurrent_change' });
  }
  if (error instanceof OwnershipConflict) {
    const response = { status: 'refused', reason: error.message };
    if (error.message === 'last_owner') {
      return reply.code(409).send({ ...response, rule: 'At least one owner must remain',
        action: 'appoint_another_owner' });
    }
    return reply.code(409).send(response);
  }
  return reply.code(503).send({ status: 'unavailable' });
}
