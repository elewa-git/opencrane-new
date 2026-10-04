import { approvalReviewSchema } from '@opencrane/protocol';
import { createHash, createHmac } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { AuthConfig, SessionData } from '@opencrane/auth';
import { memberAuthorisation } from '@opencrane/authz';
import { history, approvalCards, readApproval, decideApproval, authorityFence, currentAuthority } from '@opencrane/models';
import { sessionFor } from '../members/routes.ts';
import type { ChatOptions } from './routes.ts';

export function registerApprovalRoutes(app: FastifyInstance, config: AuthConfig, options?: ChatOptions) {
  app.route({ method: ['GET', 'POST'], url: '/api/conversations/:conversationId/approvals', handler: async (req, reply) => {
    const started = performance.now();
    reply.header('cache-control', 'no-store');
    const session = sessionFor(req, config, new Date());
    if (!session) return reply.code(401).send({ status: 'refused' });
    if (!options) return reply.code(503).send({ status: 'unavailable' });
    if (session.orgId !== config.expectedOrgId || options.binding.silo !== options.silo) return reply.code(403).send({ status: 'refused' });
    try {
      // Capture before identity and IAM reads; a projected removal cannot reset the baseline.
      const fresh = await authorityFence(options.store, started);
      const { conversationId } = z.object({ conversationId: z.string().regex(/^[\w-]{1,200}$/u) }).parse(req.params);
      const memberId = await options.feed.memberId(options.silo, config.issuerUrl, session.sub);
      const auth = memberAuthorisation(options.binding);
      if (memberId) fresh.include(`member-${memberId}`, `conversation-${conversationId}`);
      if (!memberId || !(await auth.check(memberId, 'member')).allowed || !(await auth.conversation(memberId, conversationId, 'read')).allowed) return reply.code(403).send({ status: 'refused' });
      if (!await accessApplied(options, memberId, conversationId, fresh.deadline)) {
        return reply.code(403).send({ status: 'refused' });
      }
      // The token covers the whole Cookie header and conversation, blocking reuse across either.
      const csrf = createHmac('sha256', config.cookieSecret)
        .update(JSON.stringify(['approval', req.headers.cookie, conversationId]))
        .digest('hex');
      if (req.method === 'GET') {
        const cards = await approvalCards(
          options.store, options.silo, conversationId, memberId, options.keys,
          undefined, fresh.deadline);
        await fresh();
        return reply.send({ cards, csrf });
      }
      if (!isApprovalCsrfValid(req, config, csrf)) {
        return reply.code(403).send({ status: 'refused' });
      }
      return await decide(req, reply, options, session, memberId, conversationId, fresh);

    } catch (error) { return reply.code(error instanceof z.ZodError ? 400 : 503).send({ status: 'unavailable' }); }
  } });
}

async function decide(req: FastifyRequest, reply: FastifyReply, options: ChatOptions, session: SessionData,
  memberId: string, conversationId: string, fresh: Awaited<ReturnType<typeof authorityFence>>) {
      const input = z.object({ approvalId: z.string().regex(/^[a-f0-9]{64}$/u), decision: z.enum(['approved', 'rejected']) }).strict().parse(req.body);
      const { request } = await readApproval(
        options.store, options.silo, input.approvalId, undefined, fresh.deadline);
      if (request.conversationId !== conversationId || request.requesterId !== memberId) return reply.code(403).send({ status: 'refused' });
      const text = options.keys.decrypt(options.silo, conversationId, request);
      approvalReviewSchema.parse(JSON.parse(text));
      if (createHash('sha256').update(text).digest('hex') !== request.reviewDigest) throw new Error('Review unavailable');
      fresh.include(`computer-${request.assistantId}`);
      await currentAuthority(options.store, options.binding, memberId, request.assistantId, conversationId, 'mcp_server', request.serverId, fresh);
      const recent = isRecentStepUp(session, input.approvalId);
      const result = await decideApproval(options.store, options.silo, input.approvalId, memberId, input.decision, recent, fresh);
      return reply.code(result.status === 'appended' ? 200 : result.status === 'unavailable' ? 503 : result.status === 'step_up_required' ? 428 : 409).send({ status: result.status });
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

async function accessApplied(options: ChatOptions, memberId: string, conversationId: string,
  deadline: number) {
  // Do not serve approval state until every relevant access change has reached OpenFGA.
  const auth = memberAuthorisation(options.binding);
  const memberRows = await history(options.store, `member-${memberId}`, options.silo, deadline);
  const conversationRows = await history(
    options.store, `conversation-${conversationId}`, options.silo, deadline);
  const rows = [...memberRows, ...conversationRows];
  const access = rows.filter(r => ['member.joined', 'silo.owner_bootstrapped', 'member.role_changed', 'member.removed', 'conversation.created', 'participant.added', 'participant.removed'].includes(r.event.type));
  return (await Promise.all(access.map(r => auth.applied(r.event.id)))).every(Boolean);
}
