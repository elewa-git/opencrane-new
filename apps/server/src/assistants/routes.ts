import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AuthConfig } from '@opencrane/auth';
import { memberAuthorisation } from '@opencrane/authz';
import { z } from 'zod';
import { authorityFence, history } from '@opencrane/models';
import { mapComputerRows, type ComputerDbRow } from '@opencrane/projections';
import type { ChatOptions } from '../chat/routes.ts';
import { sessionFor } from '../members/routes.ts';
import { activeMember, GroupConflict, GroupRefused } from '../members/groups.ts';
import { createSharedAssistant } from './commands.ts';

export function registerAssistantRoutes(
  app: FastifyInstance, config: AuthConfig, options?: ChatOptions,
) {
  app.route({ method: ['GET', 'POST'], url: '/api/assistants', bodyLimit: 8192, handler });
  app.get('/api/assistants/:assistantId', handler);
  app.get('/api/assistants/:assistantId/changes/:commandId', handler);
  async function handler(request: FastifyRequest, reply: FastifyReply) {
    reply.header('cache-control', 'no-store');
    const session = sessionFor(request, config, new Date());
    if (!session) return reply.code(401).send({ status: 'refused' });
    if (!options) return reply.code(503).send({ status: 'unavailable' });
    const origin = new URL(config.redirectUri).origin;
    if (!config.expectedOrgId || session.orgId !== config.expectedOrgId ||
        options.silo !== options.binding.silo ||
        (request.method === 'POST' && request.headers.origin !== origin)) {
      return reply.code(403).send({ status: 'refused' });
    }
    try {
      const fresh = await authorityFence(options.store, performance.now());
      const memberId = await options.feed.memberId(options.silo, config.issuerUrl, session.sub);
      if (!memberId) throw new GroupRefused('Membership required');
      fresh.include(`member-${memberId}`);
      if (request.method === 'POST') {
        return reply.send(await createSharedAssistant(
          options.store, options.binding, memberId, request.body, fresh));
      }
      const id = z.string().regex(/^[\w-]{1,200}$/u);
      const parameters = z.object({ assistantId: id.optional(), commandId: id.optional() });
      const { assistantId, commandId } = parameters.parse(request.params);
      return await read(reply, options, memberId, assistantId, commandId, fresh);
    } catch (error) {
      let code = 503;
      if (error instanceof z.ZodError) code = 400;
      if (error instanceof GroupRefused) code = 403;
      if (error instanceof GroupConflict) code = 409;
      return reply.code(code).send({ status: code === 503 ? 'unavailable' : 'refused' });
    }
  }
}

async function read(reply: FastifyReply, options: ChatOptions, memberId: string,
  assistantId: string | undefined, commandId: string | undefined,
  fresh: Awaited<ReturnType<typeof authorityFence>>) {
  await activeMember(options.store, options.binding, memberId, false, fresh);
  const auth = memberAuthorisation(options.binding);
  const admin = (await auth.check(memberId, 'admin')).allowed;
  if (commandId && assistantId) {
    if (!admin) throw new GroupRefused('Admin required');
    const result = await change(options, assistantId, commandId, fresh.deadline);
    await fresh();
    return reply.code(result.status === 'not_found' ? 404 : 200).send(result);
  }
  const result = await options.db.query<ComputerDbRow>(
    `SELECT * FROM computers WHERE silo = $1 AND kind = 'team'
      AND ($2::text IS NULL OR assistant_id = $2) ORDER BY assistant_id`,
    [options.silo, assistantId ?? null]);
  const rows = [];
  for (const computer of mapComputerRows(result.rows)) {
    fresh.include(`assistant-${computer.assistantId}`, `team-${computer.ownerId}`);
    const events = await history(options.store, `assistant-${computer.assistantId}`,
      options.silo, fresh.deadline);
    const created = events[0];
    if (!created || !await auth.applied(created.event.id)) continue;
    if (!admin) {
      const membership = await history(options.store, `team-${computer.ownerId}`,
        options.silo, fresh.deadline);
      for (const row of membership) {
        if (!await auth.applied(row.event.id)) throw new GroupRefused('Membership applying');
      }
      if (!(await auth.actsFor(memberId, computer.assistantId)).allowed) continue;
    }
    const data = z.object({ name: z.string().optional(), grants: z.array(z.unknown()).optional() });
    const details = data.parse(created.event.data);
    const computerSubject = `computer-${computer.assistantId}`;
    fresh.include(computerSubject);
    const lifecycle = await history(options.store, computerSubject, options.silo, fresh.deadline);
    rows.push({ ...computer, ...details, busy: isBusy(lifecycle) });
  }
  await fresh();
  return reply.send({ rows });
}

async function change(options: ChatOptions, assistantId: string,
  commandId: string, deadline: number) {
  const events = await history(options.store, `assistant-${assistantId}`, options.silo, deadline);
  function matchesCommand(row: typeof events[number]) {
    return row.event.commandId === commandId;
  }
  const row = events.find(matchesCommand);
  if (!row) return { status: 'not_found' as const };
  const checkpoint = await options.db.query<{ sequence: string }>(
    'SELECT sequence FROM projection_checkpoints WHERE name = $1', ['computers']);
  const applied = await memberAuthorisation(options.binding).applied(row.event.id);
  const content = Number(checkpoint.rows[0]?.sequence ?? 0) >= row.sequence ? 'current' : 'applying';
  const iam = applied ? 'current' : 'applying';
  return { status: 'appended' as const, assistantId, sequence: row.sequence,
    changeId: row.event.id, projection: { content, iam } };
}

function isBusy(rows: Awaited<ReturnType<typeof history>>) {
  const active = new Set<string>();
  for (const row of rows) {
    if (!row.event.type.startsWith('computer.turn_')) continue;
    const data = z.object({ turnId: z.string() }).parse(row.event.data);
    if (row.event.type === 'computer.turn_started') active.add(data.turnId);
    if (row.event.type === 'computer.turn_closed') active.delete(data.turnId);
  }
  return active.size > 0;
}
