import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AuthConfig } from '@opencrane/auth';
import { memberAuthorisation } from '@opencrane/authz';
import { z } from 'zod';
import { assistantCreatedDataSchema } from '@opencrane/events';
import { creationEvent, sharedAssistantRead } from '../chat/private-session.ts';
import { authorityFence, AuthorityApplying, history, PayingGroupRefused, groupMembership } from '@opencrane/models';
import { mapComputerRows, type ComputerDbRow } from '@opencrane/projections';
import type { ChatOptions } from '../chat/routes.ts';
import { sessionFor } from '../members/routes.ts';
import { readActiveMember, GroupConflict, GroupRefused } from '../members/groups.ts';
import { createSharedAssistant } from './commands.ts';

const turnDetails = z.object({ turnId: z.string() });

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
      const fresh = request.method === 'POST'
        ? await authorityFence(options.store, performance.now()) : undefined;
      const memberId = await options.feed.memberId(options.silo, config.issuerUrl, session.sub);
      if (!memberId) throw new GroupRefused('Membership required');
      fresh?.include(`member-${memberId}`);
      if (request.method === 'POST') {
        return reply.send(await createSharedAssistant(
          options.store, options.binding, memberId, request.body, fresh));
      }
      const id = z.string().regex(/^[\w-]{1,200}$/u);
      const parameters = z.object({ assistantId: id.optional(), commandId: id.optional() });
      const { assistantId, commandId } = parameters.parse(request.params);
      return await readAssistants(reply, options, memberId, assistantId, commandId);
    } catch (error) {
      return assistantRefusal(reply, error);
    }
  }
}

function assistantRefusal(reply: FastifyReply, error: unknown) {
  let code = 503;
  if (error instanceof z.ZodError) code = 400;
  if (error instanceof GroupRefused) code = 403;
  if (error instanceof GroupConflict) code = 409;
  if (error instanceof AuthorityApplying) code = 503;
  return reply.code(code).send({ status: code === 503 ? 'unavailable' : 'refused' });
}

async function readAssistants(reply: FastifyReply, options: ChatOptions, memberId: string,
  assistantId: string | undefined, commandId: string | undefined) {
  await readActiveMember(options.store, options.binding, memberId);
  const auth = memberAuthorisation(options.binding);
  const admin = (await auth.check(memberId, 'admin')).allowed;
  if (commandId && assistantId) {
    if (!admin) throw new GroupRefused('Admin required');
    const result = await change(options, assistantId, commandId);
    return reply.code(result.status === 'not_found' ? 404 : 200).send(result);
  }
  const result = await options.db.query<ComputerDbRow>(
    `SELECT * FROM computers WHERE silo = $1 AND kind = 'team'
      AND ($2::text IS NULL OR assistant_id = $2) ORDER BY assistant_id`,
    [options.silo, assistantId ?? null]);
  const rows = [];
  for (const computer of mapComputerRows(result.rows)) {
    const row = await visibleAssistant(options, memberId, computer, admin);
    if (row) rows.push(row);
  }
  return reply.send({ rows });
}

async function visibleAssistant(options: ChatOptions, memberId: string,
  computer: ReturnType<typeof mapComputerRows>[number], admin: boolean) {
  const created = await creationEvent(options.store, options.silo,
    `assistant-${computer.assistantId}`, 'assistant.created');
  if (!admin) {
    try {
      await sharedAssistantRead(options, memberId, computer.assistantId, created);
    } catch (error) {
      if (error instanceof GroupRefused || error instanceof PayingGroupRefused) return;
      throw error;
    }
  }
  const details = assistantCreatedDataSchema.parse(created.data);
  let canStartSession = false;
  if (details.payingGroupId) {
    try {
      for (const groupId of new Set([details.ownerId, details.payingGroupId])) {
        await groupMembership(options.store, options.silo, memberId, groupId, options.binding);
      }
      canStartSession = true;
    } catch (error) {
      if (!(error instanceof PayingGroupRefused) && !(error instanceof GroupRefused)) throw error;
    }
  }
  const row = await assistantRow(options, computer, created.data);
  return { ...row, canStartSession };
}

async function assistantRow(options: ChatOptions,
  computer: ReturnType<typeof mapComputerRows>[number], data: unknown) {
  const details = assistantCreatedDataSchema.parse(data);
  const lifecycle = await history(options.store, `computer-${computer.assistantId}`, options.silo);
  return { ...computer, name: details.name, grants: details.grants,
    payingGroupId: details.payingGroupId, busy: isBusy(lifecycle) };
}

async function change(options: ChatOptions, assistantId: string,
  commandId: string) {
  const events = await history(options.store, `assistant-${assistantId}`, options.silo);
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
    if (['computer.lost', 'computer.retired', 'computer.claimed'].includes(row.event.type)) {
      active.clear();
    }
    if (!row.event.type.startsWith('computer.turn_')) continue;
    const data = turnDetails.parse(row.event.data);
    if (row.event.type === 'computer.turn_started') active.add(data.turnId);
    if (row.event.type === 'computer.turn_closed') active.delete(data.turnId);
  }
  return active.size > 0;
}
