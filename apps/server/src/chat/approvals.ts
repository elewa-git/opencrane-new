import { approvalReviewSchema } from '@opencrane/protocol';
import { createHash, createHmac } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { isOrganisationSession, type AuthConfig, type SessionData } from '@opencrane/auth';
import { approvalCards, readApproval, decideApproval, currentAuthority } from '@opencrane/models';
import { chatAccess, writeChatAccess, isChatRefused, conversationParticipation, ChatAccessApplying } from './access.ts';
import { sessionFor } from '../members/routes.ts';
import type { ChatOptions } from './routes.ts';

export function registerApprovalRoutes(app: FastifyInstance, config: AuthConfig, options?: ChatOptions) {
  app.route({ method: ['GET', 'POST'], url: '/api/conversations/:conversationId/approvals', handler: async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const session = sessionFor(req, config, new Date());
    if (!session) return reply.code(401).send({ status: 'refused' });
    if (!options) return reply.code(503).send({ status: 'unavailable' });
    if (!isOrganisationSession(config, session) || options.binding.silo !== options.silo) return reply.code(403).send({ status: 'refused' });
    try {
      const { conversationId } = z.object({ conversationId: z.string().regex(/^[\w-]{1,200}$/u) }).parse(req.params);
      const memberId = await options.feed.memberId(options.silo, config.issuerUrl, session.sub);
      if (!memberId) return reply.code(403).send({ status: 'refused' });
      const accessRequest = { memberId, conversationId };
      const access = await chatAccess(options, accessRequest);
      // The token covers the whole Cookie header and conversation, blocking reuse across either.
      const csrf = createHmac('sha256', config.cookieSecret)
        .update(JSON.stringify(['approval', req.headers.cookie, conversationId]))
        .digest('hex');
      if (req.method === 'GET') {
        const readOptions = { deadline: performance.now() + 10_000,
          fromSequence: access.joinPosition };
        const cards = await approvalCards(
          options.store, options.silo, conversationId, memberId, options.keys,
          readOptions);
        return reply.send({ cards, csrf });
      }
      if (!isApprovalCsrfValid(req, config, csrf)) {
        return reply.code(403).send({ status: 'refused' });
      }
      return await decide(req, reply, options, session, memberId, conversationId,
        access.joinPosition);

    } catch (error) {
      if (error instanceof ChatAccessApplying) {
        return reply.code(425).send({ status: 'access_applying' });
      }
      if (isChatRefused(error)) return reply.code(403).send({ status: 'refused' });
      return reply.code(error instanceof z.ZodError ? 400 : 503).send({ status: 'unavailable' });
    }
  } });
}

async function decide(req: FastifyRequest, reply: FastifyReply, options: ChatOptions,
  session: SessionData, memberId: string, conversationId: string, joinPosition: number) {
  const inputSchema = z.object({
    approvalId: z.string().regex(/^[a-f0-9]{64}$/u),
    decision: z.enum(['approved', 'rejected', 'retry']),
  }).strict();
  const input = inputSchema.parse(req.body);
  const readOptions = { deadline: performance.now() + 10_000 };
  const checked = await readApproval(options.store, options.silo, input.approvalId, readOptions);
  const { request, requestPosition } = checked;
  if (request.conversationId !== conversationId || request.requesterId !== memberId) {
    return reply.code(403).send({ status: 'refused' });
  }
  if (requestPosition < joinPosition) return reply.code(403).send({ status: 'refused' });
  const text = options.keys.decrypt(options.silo, conversationId, request);
  approvalReviewSchema.parse(JSON.parse(text));
  const reviewDigest = createHash('sha256').update(text).digest('hex');
  if (reviewDigest !== request.reviewDigest) throw new Error('Review unavailable');
  const accessRequest = { memberId, conversationId, relation: 'post' as const };
  const fresh = await writeChatAccess(options, accessRequest);
  const access = await conversationParticipation(options, memberId, conversationId,
    fresh.deadline, 'post');
  if (requestPosition < access.joinPosition) {
    return reply.code(403).send({ status: 'refused' });
  }
  fresh.include(`computer-${request.assistantId}`);
  await currentAuthority(options.store, options.binding, memberId, request.assistantId,
    conversationId, 'mcp_server', request.serverId, fresh, access.authorityRows);
  const recent = isRecentStepUp(session, input.approvalId);
  const result = await decideApproval(options.store, options.silo, input.approvalId,
    memberId, input.decision, recent, fresh, checked);
  const statusCode = approvalDecisionStatus(result.status);
  return reply.code(statusCode).send({ status: result.status });
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

// Origin blocks cross-site posts; the token blocks reuse across sessions or conversations.
// Replays within the same session and conversation remain valid.
function isApprovalCsrfValid(req: FastifyRequest, config: AuthConfig, expectedToken: string): boolean {
  const expectedOrigin = new URL(config.redirectUri).origin;
  const submittedOrigin = req.headers.origin;
  const submittedToken = req.headers['x-csrf-token'];
  return submittedOrigin === expectedOrigin && submittedToken === expectedToken;
}
