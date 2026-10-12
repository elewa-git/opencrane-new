import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { isOrganisationSession, type AuthConfig } from '@opencrane/auth';
import { currentMembership, readActiveMember, MemberAccessRefused } from '@opencrane/models';
import { memberAccessSchema, memberDepartureSchema } from '@opencrane/protocol';
import type { GroupOptions } from './group-routes.ts';
import { extendToolAvailability } from '../integrations/access-explanation.ts';
import { sessionFor } from './routes.ts';
import { memberInventory, reviewedRevision } from './inventory.ts';

const parameters = z.object({ memberId: z.string().regex(/^[\w-]{1,200}$/u) }).strict();
export function registerMemberInventory(app: FastifyInstance, config: AuthConfig,
  options?: GroupOptions) {
  app.get('/api/members/:memberId/access', handler);
  app.get('/api/members/:memberId/departure', handler);
  async function handler(request: FastifyRequest, reply: FastifyReply) {
    reply.header('cache-control', 'no-store');
    const session = sessionFor(request, config, new Date());
    if (!session) return reply.code(401).send({ status: 'refused' });
    if (!options) return reply.code(503).send({ status: 'unavailable' });
    if (!isOrganisationSession(config, session) || options.silo !== options.binding.silo) {
      return reply.code(403).send({ status: 'refused' });
    }
    const parsed = parameters.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ status: 'refused' });
    function expire() {
      if (!reply.sent) void reply.code(503).send({ status: 'unavailable' });
    }
    const watchdog = setTimeout(expire, 10_000);
    try {
      const caller = await options.feed.memberId(options.silo, config.issuerUrl, session.sub);
      if (!caller) throw new MemberAccessRefused('Active membership required');
      await readActiveMember(options.store, options.binding, caller, 'admin');
      const memberId = parsed.data.memberId;
      const memberSequence = await options.store.head(`member-${memberId}`);
      const target = await currentMembership(options.store, options.silo, memberId);
      if (!target.role) return reply.code(404).send({ status: 'not_found' });
      const inventory = await memberInventory(options, memberId, performance.now() + 10_000);
      if (reply.sent) return reply;
      return await sendInventory(reply, request, options, memberId, target, inventory, memberSequence);
    } catch (error) {
      if (reply.sent) return reply;
      let code = 503;
      if (error instanceof MemberAccessRefused) code = 403;
      return reply.code(code).send({ status: code === 503 ? 'unavailable' : 'refused' });
    } finally {
      clearTimeout(watchdog);
    }
  }
}

async function sendInventory(reply: FastifyReply, request: FastifyRequest, options: GroupOptions,
  memberId: string, target: Awaited<ReturnType<typeof currentMembership>>,
  inventory: Awaited<ReturnType<typeof memberInventory>>, memberSequence: number) {
  const checkedAt = new Date().toISOString();
  const { rows, assistantIds: _assistantIds, checkCurrent: _checkCurrent,
    grantInputsComplete: _grantInputsComplete, ...departure } = inventory;
  if (request.routeOptions.url?.endsWith('/access')) {
    await extendToolAvailability(options, memberId, inventory, performance.now() + 10_000);
    if (reply.sent) return reply;
    const unavailableSections = [...inventory.unavailableSections];
    if (rows.length) unavailableSections.push('use_availability');
    const body = { checkedAt, complete: unavailableSections.length === 0, unavailableSections, rows };
    return reply.send(memberAccessSchema.parse(body));
  }
  const ownershipSequence = target.ownership.at(-1)?.sequence ?? 0;
  const memberNow = await options.store.head(`member-${memberId}`);
  const ownershipNow = await options.store.head(`ownership-${options.silo}`);
  if (memberNow !== memberSequence || ownershipNow !== ownershipSequence) {
    departure.complete = false;
    departure.unavailableSections.push('changed_membership');
  }
  departure.reviewRevision = reviewedRevision(departure.reviewRevision, memberSequence,
    ownershipSequence);
  const body = { ...departure, accessLost: rows, checkedAt, memberSequence,
    ownershipSequence, permissions: { remove: departure.complete && target.role !== 'owner' } };
  return reply.send(memberDepartureSchema.parse(body));
}
