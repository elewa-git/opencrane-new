import { approvalReviewSchema } from '@opencrane/protocol';
import { toolApprovalRequestedDataSchema } from '@opencrane/events';
import type { StoredEvent } from '@opencrane/event-store';
import { createHash, createHmac } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { AuthConfig, SessionData } from '@opencrane/auth';
import { approvalCards, readApproval, decideApproval, currentAuthority, approvalActivity }
  from '@opencrane/models';
import { readEvents } from '@opencrane/projections';
import { writeChatAccess, isChatRefused, conversationParticipation, ChatAccessApplying } from './access.ts';
import { requireMember, MemberRefusal, idSchema } from '../members/guard.ts';
import type { ChatOptions } from './routes.ts';

const conversationParameters = z.object({ conversationId: idSchema.regex(/^[\w-]{1,200}$/u) });

export function registerApprovalRoutes(app: FastifyInstance, config: AuthConfig, options?: ChatOptions) {
  const route = { method: ['GET', 'POST'] as ('GET' | 'POST')[],
    url: '/api/conversations/:conversationId/approvals', handler };
  app.route(route);
  async function handler(req: FastifyRequest, reply: FastifyReply) {
    reply.header('cache-control', 'no-store');
    try {
      const { conversationId } = conversationParameters.parse(req.params);
      const checks = { write: req.method === 'POST', conversationId };
      const context = await requireMember(req, reply, config, options, checks);
      const { session, memberId, access } = context;
      const configured = context.options;
      // The token covers the whole Cookie header and conversation, blocking reuse across either.
      const csrf = createHmac('sha256', config.cookieSecret)
        .update(JSON.stringify(['approval', req.headers.cookie, conversationId]))
        .digest('hex');
      if (req.method === 'GET') {
        const deadline = performance.now() + 10_000;
        const approvalRows = await approvalRequestEvents(configured, conversationId,
          access.historyPosition, deadline);
        const readOptions = { deadline, fromSequence: access.historyPosition, approvalRows,
          requesterOnly: access.contextKind === 'shared_child' };
        const cards = await approvalCards(
          configured.store, configured.silo, conversationId, memberId, configured.keys,
          readOptions);
        return reply.send({ cards, csrf });
      }
      if (!isApprovalCsrfValid(req, csrf)) {
        return reply.code(403).send({ status: 'refused' });
      }
      return await decide(req, reply, configured, session, memberId, conversationId,
        access.joinPosition);

    } catch (error) {
      if (error instanceof MemberRefusal) {
        return reply.code(error.statusCode).send({ status: error.status });
      }
      if (error instanceof ChatAccessApplying) {
        return reply.code(425).send({ status: 'access_applying' });
      }
      if (isChatRefused(error)) return reply.code(403).send({ status: 'refused' });
      return reply.code(error instanceof z.ZodError ? 400 : 503).send({ status: 'unavailable' });
    }
  }
}

async function approvalRequestEvents(options: ChatOptions, conversationId: string,
  historyPosition: number, deadline: number) {
  const head = await options.store.head(undefined, deadline);
  const checkpoint = await options.db.query<{ sequence: string }>(
    `SELECT sequence FROM projection_checkpoints WHERE name = 'audit'`);
  const projectedSequence = Number(checkpoint.rows[0]?.sequence);
  if (!Number.isSafeInteger(projectedSequence) || projectedSequence < 0) {
    throw new Error('Audit projection position is unavailable');
  }
  const indexedEvents = await indexedApprovalEvents(options, conversationId,
    historyPosition, Math.min(projectedSequence, head), deadline);
  const tailStart = Math.max(historyPosition, projectedSequence + 1);
  const unprojectedEvents = await unprojectedApprovalEvents(options, conversationId,
    tailStart, head, deadline);
  return [...indexedEvents, ...unprojectedEvents];
}

async function indexedApprovalEvents(options: ChatOptions, conversationId: string,
  historyPosition: number, projectedHead: number, deadline: number) {
  const indexed = await options.db.query<{ position: string; event_id: string }>(
    `SELECT position, event_id FROM audit_entries
      WHERE silo = $1 AND conversation_id = $2 AND metadata->>'type' = $3
        AND position >= $4 AND position <= $5 ORDER BY position`,
    [options.silo, conversationId, 'tool.approval_requested', historyPosition,
      projectedHead]);
  const events: StoredEvent[] = [];
  for (const reference of indexed.rows) {
    const event = await options.store.readEvent(Number(reference.position), deadline);
    requireApprovalRequestEvent(event, options.silo, conversationId, reference.event_id);
    events.push(event);
  }
  return events;
}

async function unprojectedApprovalEvents(options: ChatOptions, conversationId: string,
  tailStart: number, head: number, deadline: number) {
  const remaining = Math.max(0, Math.ceil(deadline - performance.now()));
  const signal = AbortSignal.timeout(remaining);
  const events: StoredEvent[] = [];
  for await (const event of readEvents(options.store, tailStart, head, signal)) {
    if (!isApprovalRequestFor(event, options.silo, conversationId)) continue;
    events.push(event);
  }
  return events;
}

function isApprovalRequestFor(event: StoredEvent, silo: string, conversationId: string) {
  if (event.event.silo !== silo || event.event.type !== 'tool.approval_requested') return false;
  const request = toolApprovalRequestedDataSchema.parse(event.event.data);
  return request.conversationId === conversationId &&
    event.event.subject === `approval-${request.approvalId}`;
}

function requireApprovalRequestEvent(event: StoredEvent, silo: string,
  conversationId: string, eventId: string) {
  const request = toolApprovalRequestedDataSchema.parse(event.event.data);
  if (event.event.id !== eventId || event.event.silo !== silo ||
      event.event.subject !== `approval-${request.approvalId}` ||
      event.event.type !== 'tool.approval_requested' ||
      request.conversationId !== conversationId) {
    throw new Error('Approval history changed');
  }
}

async function decide(req: FastifyRequest, reply: FastifyReply, options: ChatOptions,
  session: SessionData, memberId: string, conversationId: string, joinPosition: number) {
  const inputSchema = z.object({
    approvalId: z.string().regex(/^[a-f0-9]{64}$/u),
    decision: z.enum(['approved', 'rejected', 'retry']),
  }).strict();
  const input = inputSchema.parse(req.body);
  const checked = await readDecisionApproval(options, input.approvalId);
  const { request, requestPosition } = checked;
  if (request.conversationId !== conversationId || request.requesterId !== memberId) {
    return reply.code(403).send({ status: 'refused' });
  }
  if (requestPosition < joinPosition) return reply.code(403).send({ status: 'refused' });
  const text = options.keys.decrypt(options.silo, conversationId, request);
  approvalReviewSchema.parse(JSON.parse(text));
  const reviewDigest = createHash('sha256').update(text).digest('hex');
  if (reviewDigest !== request.reviewDigest) throw new Error('Review unavailable');
  const activity = await approvalActivity(options.store, options.silo, request.assistantId,
    conversationId, request.turnId, performance.now() + 10_000);
  if (input.decision !== 'rejected' && activity.computer.control) {
    return reply.code(409).send({ status: 'conflict' });
  }
  const accessRequest = { memberId, conversationId, relation: 'post' as const };
  const fresh = await writeChatAccess(options, accessRequest);
  const access = await conversationParticipation(options, memberId, conversationId,
    fresh.deadline, 'post');
  if (requestPosition < access.joinPosition) {
    return reply.code(403).send({ status: 'refused' });
  }
  async function confirm() {
    await fresh();
    if (input.decision !== 'rejected') await activity.confirm(fresh.deadline, true);
  }
  const deadline = { deadline: fresh.deadline };
  const checkedAuthority = Object.assign(confirm, deadline);
  await currentAuthority(options.store, options.binding, memberId, request.assistantId,
    conversationId, 'mcp_server', request.serverId, fresh, access.authorityRows);
  const recent = isRecentStepUp(session, input.approvalId);
  const result = await decideApproval(options.store, options.silo, input.approvalId,
    memberId, input.decision, recent, checkedAuthority, checked);
  const statusCode = approvalDecisionStatus(result.status);
  return reply.code(statusCode).send({ status: result.status });
}

async function readDecisionApproval(options: ChatOptions, approvalId: string) {
  const readOptions = { deadline: performance.now() + 10_000, deferInvalidation: true };
  try {
    const subject = `approval-${approvalId}`;
    for await (const { event } of options.store.readStream(subject, 1, readOptions.deadline)) {
      if (event.silo !== options.silo) throw new MemberRefusal(403, 'refused');
      break;
    }
    return await readApproval(options.store, options.silo, approvalId, readOptions);
  } catch (error) {
    // Hide missing approval records in the same way as another person's approval.
    if (error instanceof z.ZodError) {
      throw new MemberRefusal(403, 'refused', { cause: error });
    }
    throw error;
  }
}

function approvalDecisionStatus(status: Awaited<ReturnType<typeof decideApproval>>['status']) {
  if (status === 'appended') return 200;
  if (status === 'unavailable') return 503;
  if (status === 'step_up_required') return 428;
  return 409;
}

// D07 requires verified OIDC auth_time within five minutes; #141 tracks the configurable age question.
const APPROVAL_STEP_UP_MAX_AGE_SECONDS = 300;

function isRecentStepUp(session: SessionData, approvalId: string): boolean {
  if (session.stepUpApproval !== approvalId) {
    return false;
  }
  if (session.authTime <= 0) {
    return false;
  }
  if (session.authTime > Date.now() / 1000) {
    return false;
  }
  return Date.now() / 1000 - session.authTime <= APPROVAL_STEP_UP_MAX_AGE_SECONDS;
}

// Bind the token to this session and conversation after the guard checks Origin.
// Replays within the same session and conversation remain valid.
function isApprovalCsrfValid(req: FastifyRequest, expectedToken: string): boolean {
  const submittedToken = req.headers['x-csrf-token'];
  return submittedToken === expectedToken;
}
