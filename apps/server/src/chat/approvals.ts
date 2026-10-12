import { approvalReviewSchema } from '@opencrane/protocol';
import { createHash, createHmac } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { AuthConfig, SessionData } from '@opencrane/auth';
import { approvalCards, readApproval, decideApproval, currentAuthority, approvalActivity }
  from '@opencrane/models';
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
        const readOptions = { deadline: performance.now() + 10_000,
          fromSequence: access.historyPosition };
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
  const readOptions = { deadline: performance.now() + 10_000 };
  try {
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
