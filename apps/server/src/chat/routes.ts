import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { AuthConfig } from '@opencrane/auth';
import { memberAuthorisation, type Binding } from '@opencrane/authz';
import type { EventStore } from '@opencrane/event-store';
import { listConversations, readConversation, type Query, type connectMemberFeed } from '@opencrane/projections';
import { sessionFor } from '../members/routes.ts';
import { chatCommand, chatInput } from './commands.ts';
import type { conversationKeys } from './keys.ts';

export interface ChatOptions {
  silo: string; store: EventStore; db: Query; keys: ReturnType<typeof conversationKeys>; binding: Binding;
  feed: Pick<Awaited<ReturnType<typeof connectMemberFeed>>, 'memberId'>;
}
export async function chatRows(options: ChatOptions, conversationId: string, since = 0) {
  const result = await readConversation(options.db, options.silo, conversationId, since);
  const computers = await options.db.query<{ status: string }>(`SELECT c.status FROM computers c JOIN conversation_feed f
    ON f.silo = c.silo AND f.data->>'assistantId' = c.assistant_id
    WHERE f.silo = $1 AND f.conversation_id = $2 AND f.type = 'conversation.created'`, [options.silo, conversationId]);
  const state = computers.rows[0]?.status;
  return { ...result, computerState: state === 'ready' ? 'ready' : 'starting your computer', rows: result.rows.map(row => {
    const data = z.record(z.string(), z.unknown()).parse(row.data);
    if (!('ciphertext' in data)) return row;
    const { ciphertext: _ciphertext, keyId: _keyId, ...rest } = data;
    return { ...row, data: { ...rest, text: options.keys.decrypt(options.silo, conversationId, data) } };
  }) };
}
export function registerChatRoutes(app: FastifyInstance, config: AuthConfig, options?: ChatOptions) {
  app.route({ method: ['GET', 'POST'], url: '/api/conversations', handler });
  app.route({ method: ['GET', 'POST'], url: '/api/conversations/:conversationId/messages', handler });
  async function handler(request: FastifyRequest, reply: FastifyReply) {
    const session = sessionFor(request, config, new Date());
    if (!session) return reply.code(401).send({ status: 'refused' });
    if (!options) return reply.code(503).send({ status: 'unavailable' });
    if (session.orgId !== config.expectedOrgId || options.silo !== options.binding.silo ||
      (request.method === 'POST' && request.headers.origin !== new URL(config.redirectUri).origin)) return reply.code(403).send({ status: 'refused' });
    try {
      const auth = memberAuthorisation(options.binding);
      const memberId = await options.feed.memberId(options.silo, config.issuerUrl, session.sub);
      if (!memberId || !(await auth.check(memberId, 'member')).allowed) return reply.code(403).send({ status: 'refused' });
      const { conversationId } = z.object({ conversationId: z.string().regex(/^[\w-]{1,200}$/u).optional() }).parse(request.params);
      if (conversationId && !(await auth.conversation(memberId, conversationId, request.method === 'POST' ? 'post' : 'read')).allowed) return reply.code(403).send({ status: 'refused' });
      if (request.method === 'GET') return await read(request, reply, options, memberId, conversationId);
      return await write(request, reply, options, memberId, conversationId);
    } catch (error) {
      return chatRefusal(reply, error);
    }
  }
}

async function read(request: FastifyRequest, reply: FastifyReply, options: ChatOptions, memberId: string, conversationId?: string) {
  const auth = memberAuthorisation(options.binding);
        if (conversationId) {
          const { since } = z.object({ since: z.coerce.number().int().nonnegative().default(0) }).parse(request.query);
          return reply.send(await chatRows(options, conversationId, since));
        }
        const rows = [];
        for (const row of await listConversations(options.db, options.silo)) {
          if ((await auth.conversation(memberId, row.conversationId, 'read')).allowed) rows.push(row);
        }
        return reply.send({ rows });

}

async function write(request: FastifyRequest, reply: FastifyReply, options: ChatOptions, memberId: string, conversationId?: string) {
  const auth = memberAuthorisation(options.binding);
      const input = chatInput.parse({ ...z.record(z.string(), z.unknown()).parse(request.body), ...(conversationId ? { conversationId } : {}) });
      if ('assistantId' in input) {
        if (conversationId || !(await auth.actsFor(memberId, input.assistantId)).allowed) return reply.code(403).send({ status: 'refused' });
        options.keys.provision(options.silo, input.conversationId);
      } else if (!conversationId) return reply.code(400).send({ status: 'invalid_request' });
      const result = await chatCommand(options.store, options.keys, { silo: options.silo, memberId }, input);
      return reply.code(result.status === 'appended' ? 200 : result.status === 'unavailable' ? 503 : 409)
        .send(result.status === 'appended' ? result : { status: result.status });

}

function chatRefusal(reply: FastifyReply, error: unknown) {
      if (error instanceof Error && error.message === 'Phase 2 supports only agent_session conversations') return reply.code(400).send({ status: 'refused', error: error.message });
      return reply.code(error instanceof z.ZodError ? 400 : 409).send({ status: 'refused' });
}
