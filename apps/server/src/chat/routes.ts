import { history, payingGroupAuthority, PayingGroupRefused } from '@opencrane/models';
import { sessionSlug } from '@opencrane/protocol';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { AuthConfig } from '@opencrane/auth';
import { memberAuthorisation } from '@opencrane/authz';
import {
  listConversations, readConversation,
} from '@opencrane/projections';
import { chatAccess, activeChatMember, recordedChatMode, isChatRefused, ChatRefused, type ChatOptions } from './access.ts';
import { sessionFor } from '../members/routes.ts';
import { colleagues, chatChange } from './reads.ts';
import { chatCommand, chatInput, ChatConflict } from './commands.ts';

export type { ChatOptions } from './access.ts';
type Fresh = Awaited<ReturnType<typeof chatAccess>>;
const id = z.string().regex(/^[\w-]{1,200}$/u);
class InvalidChatRequest extends Error {}
const parameters = z.object({ conversationId: id.optional(), commandId: id.optional() });

export async function chatRows(options: ChatOptions, conversationId: string,
  mode: 'agent_session' | 'direct', since = 0) {
  const result = await readConversation(options.db, options.silo, conversationId, since);
  const computerState = await conversationComputerState(options, conversationId, mode);
  function decryptRow(row: (typeof result.rows)[number]) {
    const data = z.record(z.string(), z.unknown()).parse(row.data);
    if (!('ciphertext' in data)) return row;
    const { ciphertext: _ciphertext, keyId: _keyId, ...rest } = data;
    const text = options.keys.decrypt(options.silo, conversationId, data);
    return { ...row, data: { ...rest, text } };
  }
  const rows = result.rows.map(decryptRow);
  return { ...result, computerState, rows };
}

async function conversationComputerState(options: ChatOptions, conversationId: string,
  mode: 'agent_session' | 'direct') {
  // Authorisation read the recorded mode; content projection may still be applying.
  if (mode === 'direct') return 'not_applicable';
  const computers = await options.db.query<{ status: string }>(
    `SELECT c.status FROM computers c JOIN conversation_feed f
      ON f.silo = c.silo AND f.data->>'assistantId' = c.assistant_id
      WHERE f.silo = $1 AND f.conversation_id = $2 AND f.type = 'conversation.created'`,
    [options.silo, conversationId]);
  if (computers.rows[0]?.status === 'ready') return 'ready';
  return 'starting your computer';
}

export function registerChatRoutes(app: FastifyInstance, config: AuthConfig, options?: ChatOptions) {
  app.get('/api/chat', handler);
  app.get('/api/chat/colleagues', handler);
  app.get('/api/conversations/:conversationId/changes/:commandId', handler);
  const conversationsRoute = { method: ['GET', 'POST'] as ('GET' | 'POST')[], url: '/api/conversations', handler };
  const messagesRoute = {
    method: ['GET', 'POST'] as ('GET' | 'POST')[], url: '/api/conversations/:conversationId/messages', handler,
  };
  app.route(conversationsRoute);
  app.route(messagesRoute);
  async function handler(request: FastifyRequest, reply: FastifyReply) {
    reply.header('cache-control', 'no-store');
    const session = sessionFor(request, config, new Date());
    if (!session) return reply.code(401).send({ status: 'refused' });
    if (!options) return reply.code(503).send({ status: 'unavailable' });
    if (!trustedRequest(request, config, options, session.orgId)) {
      return reply.code(403).send({ status: 'refused' });
    }
    try {
      const memberId = await options.feed.memberId(options.silo, config.issuerUrl, session.sub);
      if (!memberId) throw new ChatRefused('Membership required');
      const { conversationId, commandId } = parameters.parse(request.params);
      const relation: 'post' | 'read' = request.method === 'POST' ? 'post' : 'read';
      const allowApplying = commandId !== undefined;
      const accessRequest = { memberId, conversationId, relation, allowApplying };
      const fresh = await chatAccess(options, accessRequest);
      if (request.method === 'GET') {
        let result;
        if (conversationId && commandId) {
          result = await chatChange(options, conversationId, commandId, fresh);
        } else {
          result = await read(request, options, memberId, conversationId, fresh);
        }
        await fresh();
        if ('status' in result && result.status === 'not_found') reply.code(404);
        return reply.send(result);
      }
      const result = await write(request, options, memberId, conversationId);
      const code = appendStatusCode(result);
      let response: unknown = { status: result.status };
      if (result.status === 'appended') response = result;
      return reply.code(code).send(response);
    } catch (error) {
      return chatRefusal(request, reply, error);
    }
  }
}

function trustedRequest(
  request: FastifyRequest, config: AuthConfig, options: ChatOptions, orgId?: string,
) {
  if (!config.expectedOrgId || orgId !== config.expectedOrgId) return false;
  if (options.silo !== options.binding.silo) return false;
  if (request.method !== 'POST') return true;
  return request.headers.origin === new URL(config.redirectUri).origin;
}

async function read(
  request: FastifyRequest, options: ChatOptions, memberId: string,
  conversationId: string | undefined, fresh: Fresh,
) {
  if (request.routeOptions.url === '/api/chat/colleagues') {
    return colleagues(options, memberId, request.query);
  }
  if (request.routeOptions.url === '/api/chat') return personalContext(options, memberId);
  if (conversationId) {
    const query = z.object({ since: z.coerce.number().int().nonnegative().default(0) });
    const { since } = query.parse(request.query);
    const mode = recordedChatMode(fresh);
    return chatRows(options, conversationId, mode, since);
  }
  return conversationList(options, memberId, fresh);
}

async function conversationList(options: ChatOptions, memberId: string, fresh: Fresh) {
  const pending = [];
  const conversations = await listConversations(options.db, options.silo);
  for (const row of conversations) {
    try {
      const request = { memberId, conversationId: row.conversationId, deadline: fresh.deadline };
      const access = await chatAccess(options, request);
      const display = await summary(options, row.conversationId, recordedChatMode(access));
      pending.push({ row: { ...row, ...display }, access });
    } catch (error) {
      if (!rowAccessChanged(error)) throw error;
    }
  }
  const rows = [];
  // Fence each row after all summaries, so a revoked earlier row cannot leak its title.
  for (const entry of pending) {
    try {
      await entry.access();
      rows.push(entry.row);
    } catch (error) {
      if (!rowAccessChanged(error)) throw error;
    }
  }
  return { rows };
}

function rowAccessChanged(error: unknown) {
  return isChatRefused(error) ||
    (error instanceof Error && error.message === 'Authority changed');
}

async function personalContext(options: ChatOptions, memberId: string) {
  const result = await options.db.query<{ assistant_id: string }>(
    "SELECT assistant_id FROM computers WHERE silo = $1 AND owner_id = $2 AND kind = 'personal'",
    [options.silo, memberId]);
  const member = await options.db.query<{ display_name: string | null }>(
    'SELECT display_name FROM members WHERE silo = $1 AND member_id = $2', [options.silo, memberId]);
  let assistantId: string | null = result.rows[0]?.assistant_id ?? null;
  if (assistantId) {
    const permission = await memberAuthorisation(options.binding).actsFor(memberId, assistantId);
    if (!permission.allowed) assistantId = null;
  }
  return { memberId, displayName: member.rows[0]?.display_name ?? null, assistantId };
}

type SummaryRow = { type: string; data: unknown };
function isFirstMessage(row: SummaryRow) {
  return row.type === 'message.posted';
}
function changesStatus(row: SummaryRow) {
  return [
    'message.posted', 'agent.turn_started', 'agent.turn_completed', 'agent.turn_failed',
    'agent.turn_stop_requested', 'conversation.closed',
  ].includes(row.type);
}
function conversationStatus(last: SummaryRow | undefined, mode: string) {
  if (last?.type === 'conversation.closed') return 'closed';
  if (mode === 'direct' || !last) return 'open';
  if (last.type === 'agent.turn_failed') return 'failed';
  if (last.type === 'agent.turn_stop_requested') return 'stopped';
  if (last.type === 'agent.turn_completed') return 'done';
  return 'working';
}
async function summary(options: ChatOptions, conversationId: string, mode: string) {
  // Scan authorised history for now; a summary projection can replace this when histories grow.
  const result = await options.db.query<SummaryRow>(
    `SELECT type, data FROM conversation_feed
      WHERE silo = $1 AND conversation_id = $2 ORDER BY position`, [options.silo, conversationId]);
  const first = result.rows.find(isFirstMessage);
  const last = result.rows.findLast(changesStatus);
  let title = 'New session';
  if (first) title = sessionSlug(options.keys.decrypt(options.silo, conversationId, first.data));
  return { title, status: conversationStatus(last, mode) };
}

async function write(
  request: FastifyRequest, options: ChatOptions, memberId: string,
  conversationId?: string,
) {
  const body = z.record(z.string(), z.unknown()).parse(request.body);
  if (conversationId && 'conversationId' in body) {
    throw new InvalidChatRequest('Conversation id belongs in the path');
  }
  let value = body;
  if (conversationId) value = { ...body, conversationId };
  const input = chatInput.parse(value);
  if ('mode' in input && conversationId) {
    throw new InvalidChatRequest('Creation belongs on the conversation route');
  }
  if ('colleagueId' in input && input.colleagueId === memberId) {
    throw new InvalidChatRequest('A direct chat needs another person');
  }
  if (!('mode' in input) && !conversationId) {
    throw new InvalidChatRequest('Conversation required');
  }
  if ('mode' in input) options.keys.provision(options.silo, input.conversationId);
  async function checkFresh(operation: 'retry' | 'append') {
    // Stream reads use the command's budget. Recheck current access just before its append.
    const request = { memberId, conversationId, relation: 'post' as const };
    const fresh = await chatAccess(options, request);
    if ('assistantId' in input) {
      const payerFresh = await assistantCreation(options, memberId, input, fresh);
      await payerFresh?.();
    }
    let colleagueId = fresh.colleagueId;
    if ('colleagueId' in input) colleagueId = input.colleagueId;
    // A retry reports an existing append. New posts need both people still in the silo.
    if (operation === 'append' && colleagueId) {
      await activeChatMember(options, colleagueId, fresh);
    }
    await fresh();
  }
  const context = { silo: options.silo, memberId };
  return chatCommand(options.store, options.keys, context, input, checkFresh);
}

async function assistantCreation(
  options: ChatOptions, memberId: string,
  input: Extract<z.infer<typeof chatInput>, { assistantId: string }>, fresh: Fresh,
) {
  fresh.include(`assistant-${input.assistantId}`);
  const auth = memberAuthorisation(options.binding);
  if (!(await auth.actsFor(memberId, input.assistantId)).allowed) {
    throw new ChatRefused('Assistant refused');
  }
  const rows = await history(
    options.store, `assistant-${input.assistantId}`, options.silo, fresh.deadline);
  function isAssistant(row: (typeof rows)[number]) {
    return row.event.type === 'assistant.created';
  }
  const assistant = rows.find(isAssistant);
  const kind = z.object({ kind: z.string() }).parse(assistant?.event.data).kind;
  if (kind !== 'team') return undefined;
  if (!input.payingGroupId) throw new PayingGroupRefused('Paying group required for shared work');
  return payingGroupAuthority(
    options.store, options.silo, memberId, input.payingGroupId, options.binding, fresh.deadline);
}

function chatRefusal(request: FastifyRequest, reply: FastifyReply, error: unknown) {
  if (error instanceof PayingGroupRefused) {
    return reply.code(403).send({ status: 'refused', error: error.message });
  }
  if (isChatRefused(error)) return reply.code(403).send({ status: 'refused' });
  if (error instanceof z.ZodError || error instanceof InvalidChatRequest) {
    return reply.code(400).send({ status: 'refused' });
  }
  if (error instanceof ChatConflict) return reply.code(409).send({ status: 'refused' });
  const message = error instanceof Error ? error.message : 'Unknown chat error';
  request.log.error({ message }, 'Chat request unavailable');
  return reply.code(503).send({ status: 'unavailable' });
}

function appendStatusCode(result: Awaited<ReturnType<typeof chatCommand>>) {
  if (result.status === 'appended') return 200;
  if (result.status === 'unavailable') return 503;
  return 409;
}
