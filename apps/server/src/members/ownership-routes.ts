import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ownershipConfirmedSchema, ownershipTransferredSchema } from '@opencrane/events';
import { isOrganisationSession, type AuthConfig } from '@opencrane/auth';
import { memberAuthorisation } from '@opencrane/authz';
import type { StoredEvent } from '@opencrane/event-store';
import { currentMembership, currentOwnershipMembership, history,
  ownershipSubject } from '@opencrane/models';
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
    if (!isOrganisationSession(config, session) ||
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
  const deadline = performance.now() + 10_000;
  if (commandId) {
    const result = await readChange(options, commandId, deadline);
    // Keep the saved step-down receipt readable under the existing status rules.
    await ownershipStatusAccess(options.store, options.binding, actorId);
    return result;
  }
  const result = await readOwners(options, actorId, deadline);
  // Check access after loading so a removal during the read cannot expose the result.
  const membership = await ownershipAccess(options.store, options.binding, actorId);
  return { ...result, viewer: { memberId: actorId, role: membership.role } };
}
async function readOwners(options: GroupOptions, actorId: string, deadline: number) {
  const ownership = await currentOwnershipMembership(
    options.store, options.silo, actorId, deadline);
  const ownerIds = [...ownership.owners];
  ownerIds.sort();
  const owners = [];
  for (const memberId of ownerIds) {
    const rows = await history(options.store, `member-${memberId}`, options.silo, deadline);
    const joined = rows.findLast(isJoined);
    const fields = z.object({ displayName: z.string() }).parse(joined?.event.data);
    owners.push({ memberId, displayName: fields.displayName, role: 'owner' as const });
  }
  return { status: 'current', owners, sequence: ownership.ownership.at(-1)?.sequence ?? 0,
    ready: ownership.ownership.length > 0 };
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
  let appliedEvent = row;
  if (row.event.type === 'ownership.transferred'
    && ownershipTransferredSchema.parse(row.event.data).awaitingConfirmation) {
    const transfer = ownershipTransferredSchema.parse(row.event.data);
    const member = await currentMembership(options.store, options.silo, transfer.memberId,
      undefined, deadline);
    function confirmsRequest(candidate: StoredEvent) {
      return ownershipConfirmedSchema.parse(candidate.event.data).appointmentId === row?.event.id;
    }
    const confirmation = member.confirmations.find(confirmsRequest);
    if (!confirmation) {
      return { ...ownershipReceipt(row), projection: { content: 'applying', iam: 'applying' } };
    }
    appliedEvent = confirmation;
  }
  const checkpoint = await options.db.query<{ sequence: string }>(
    'SELECT sequence FROM projection_checkpoints WHERE name = $1', ['members']);
  const contentSequence = Number(checkpoint.rows[0]?.sequence ?? 0);
  const content = contentSequence >= appliedEvent.sequence ? 'current' : 'applying';
  const applied = await memberAuthorisation(options.binding).applied(appliedEvent.event.id);
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
