import {
  creationEvent, readPrivateSession, writePrivateSession, sharedAssistantAuthority,
  privateSessionReader,
} from './private-session.ts';
import { GroupRefused, readActiveMember } from '../members/groups.ts';
import { authorityFence, AuthorityApplying, PayingGroupRefused } from '@opencrane/models';
import { sessionSlug } from '@opencrane/protocol';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { AuthConfig } from '@opencrane/auth';
import { memberAuthorisation, type Binding } from '@opencrane/authz';
import type { EventStore } from '@opencrane/event-store';
import {
  listConversations, readConversation, type Query, type connectMemberFeed,
} from '@opencrane/projections';
import { sessionFor } from '../members/routes.ts';
import { chatCommand, chatInput } from './commands.ts';
import type { conversationKeys } from './keys.ts';

const conversationParams = z.object({
  conversationId: z.string().regex(/^[\w-]{1,200}$/u).optional(),
});
const assistantDetails = z.object({ kind: z.string(), payingGroupId: z.string().optional() });
export interface ChatOptions {
  silo: string;
  store: EventStore;
  db: Query;
  keys: ReturnType<typeof conversationKeys>;
  binding: Binding;
  feed: Pick<Awaited<ReturnType<typeof connectMemberFeed>>, 'memberId'>;
}

async function chatRows(options: ChatOptions, memberId: string,
  conversationId: string, since = 0) {
  await readActiveMember(options.store, options.binding, memberId);
  await readPrivateSession(options, memberId, conversationId);
  return chatContent(options, conversationId, since);
}

// Read content after the caller has checked access to this conversation.
export async function chatContent(options: ChatOptions, conversationId: string, since = 0) {
  const result = await readConversation(options.db, options.silo, conversationId, since);
  const computers = await options.db.query<{ status: string }>(
    `SELECT c.status FROM computers c JOIN conversation_feed f
      ON f.silo = c.silo AND f.data->>'assistantId' = c.assistant_id
      WHERE f.silo = $1 AND f.conversation_id = $2 AND f.type = 'conversation.created'`,
    [options.silo, conversationId]);
  const state = computers.rows[0]?.status;
  function decryptRow(row: typeof result.rows[number]) {
    const data = z.record(z.string(), z.unknown()).parse(row.data);
    if (!('ciphertext' in data)) return row;
    const { ciphertext: _ciphertext, keyId: _keyId, ...rest } = data;
    const text = options.keys.decrypt(options.silo, conversationId, data);
    return { ...row, data: { ...rest, text } };
  }
  const rows = result.rows.map(decryptRow);
  const computerState = state === 'ready' ? 'ready' : 'starting your computer';
  return { ...result, computerState, rows };
}

export function registerChatRoutes(app: FastifyInstance, config: AuthConfig, options?: ChatOptions) {
  app.get('/api/chat', handler);
  app.route({ method: ['GET', 'POST'], url: '/api/conversations', handler });
  app.route({ method: ['GET', 'POST'], url: '/api/conversations/:conversationId/messages', handler });
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
      if (!memberId) throw new GroupRefused('Membership required');
      const auth = memberAuthorisation(options.binding);
      if (!(await auth.check(memberId, 'member')).allowed) {
        throw new GroupRefused('Membership required');
      }
      const { conversationId } = conversationParams.parse(request.params);
      const action = request.method === 'POST' ? 'post' : 'read';
      if (conversationId && !(await auth.conversation(memberId, conversationId, action)).allowed) {
        throw new GroupRefused('Conversation refused');
      }
      if (request.method === 'GET') {
        if (!conversationId) await readActiveMember(options.store, options.binding, memberId);
        return await readChat(request, reply, options, memberId, conversationId);
      }
      return await write(request, reply, options, memberId, conversationId);
    } catch (error) {
      return chatRefusal(reply, error);
    }
  }
}

async function readChat(request: FastifyRequest, reply: FastifyReply, options: ChatOptions,
  memberId: string, conversationId: string | undefined) {
  if (request.url === '/api/chat') return reply.send(await personalAssistant(options, memberId));
  if (conversationId) {
    const query = z.object({ since: z.coerce.number().int().nonnegative().default(0) });
    const { since } = query.parse(request.query);
    return reply.send(await chatRows(options, memberId, conversationId, since));
  }
  const auth = memberAuthorisation(options.binding);
  const rows = [];
  const readPrivate = privateSessionReader(options, memberId);
  const conversations = await listConversations(options.db, options.silo);
  async function readRow(row: typeof conversations[number]) {
    if (!(await auth.conversation(memberId, row.conversationId, 'read')).allowed) return;
    try {
      await readPrivate(row.conversationId);
      const details = await summary(options, row.conversationId);
      return { ...row, ...details };
    } catch (error) {
      // Hide denied rows, but retry when IAM has not applied the member's changes.
      if (!(error instanceof GroupRefused) && !(error instanceof PayingGroupRefused)) throw error;
      return;
    }
  }
  // Limit concurrent lookups so large lists do not fill the event store's request queue.
  for (let offset = 0; offset < conversations.length; offset += 8) {
    const batch = conversations.slice(offset, offset + 8);
    const pending = batch.map(readRow);
    const visible = await Promise.all(pending);
    for (const row of visible) {
      if (row) rows.push(row);
    }
  }
  return reply.send({ rows });
}

async function personalAssistant(options: ChatOptions, memberId: string) {
  const result = await options.db.query<{ assistant_id: string }>(
    "SELECT assistant_id FROM computers WHERE silo = $1 AND owner_id = $2 AND kind = 'personal'",
    [options.silo, memberId]);
  const member = await options.db.query<{ display_name: string | null }>(
    'SELECT display_name FROM members WHERE silo = $1 AND member_id = $2', [options.silo, memberId]);
  const assistantId = result.rows[0]?.assistant_id;
  const auth = memberAuthorisation(options.binding);
  let selectedAssistant: string | null = null;
  if (assistantId && (await auth.actsFor(memberId, assistantId)).allowed) {
    selectedAssistant = assistantId;
  }
  return { memberId, displayName: member.rows[0]?.display_name ?? null,
    assistantId: selectedAssistant };
}

function firstMessage(row: { type: string }) {
  return row.type === 'message.posted';
}
function sessionStatusEvent(row: { type: string }) {
  return ['message.posted', 'agent.turn_started', 'agent.turn_completed', 'agent.turn_failed',
    'agent.turn_stop_requested', 'conversation.closed'].includes(row.type);
}
function sessionStatus(type: string | undefined) {
  switch (type) {
    case 'conversation.closed': return 'closed';
    case 'agent.turn_failed': return 'failed';
    case 'agent.turn_stop_requested': return 'stopped';
    case 'agent.turn_completed': return 'done';
    case undefined: return 'open';
    default: return 'working';
  }
}
async function summary(options: ChatOptions, conversationId: string) {
  // Scan the stored transcript for now. Store summaries in the projection if histories grow.
  const result = await options.db.query<{ type: string; data: unknown }>(
    `SELECT type, data FROM conversation_feed
      WHERE silo = $1 AND conversation_id = $2 ORDER BY position`, [options.silo, conversationId]);
  const first = result.rows.find(firstMessage);
  const last = result.rows.findLast(sessionStatusEvent);
  let title = 'New session';
  if (first) {
    const text = options.keys.decrypt(options.silo, conversationId, first.data);
    title = sessionSlug(text);
  }
  return { title, status: sessionStatus(last?.type) };
}

async function write(request: FastifyRequest, reply: FastifyReply, options: ChatOptions,
  memberId: string, conversationId: string | undefined) {
  const body = z.record(z.string(), z.unknown()).parse(request.body);
  if (conversationId) body['conversationId'] = conversationId;
  const input = chatInput.parse(body);
  async function authorise() {
    if ('assistantId' in input) {
      if (conversationId) throw new GroupRefused('Conversation already selected');
      const fresh = await requireSessionCreation(options, memberId, input);
      options.keys.provision(options.silo, input.conversationId);
      return fresh;
    }
    if (!conversationId) throw new GroupRefused('Conversation required');
    return writePrivateSession(options, memberId, conversationId, 'stopTurnId' in input);
  }
  const result = await chatCommand(options.store, options.keys,
    { silo: options.silo, memberId }, input, authorise);
  let statusCode = 409;
  if (result.status === 'appended') statusCode = 200;
  if (result.status === 'unavailable') statusCode = 503;
  return reply.code(statusCode).send(result.status === 'appended' ? result : { status: result.status });
}

async function requireSessionCreation(options: ChatOptions, memberId: string,
  input: { assistantId: string; payingGroupId?: string | undefined }) {
  const auth = memberAuthorisation(options.binding);
  if (!(await auth.actsFor(memberId, input.assistantId)).allowed) {
    throw new GroupRefused('Assistant refused');
  }
  const assistant = await creationEvent(options.store, options.silo,
    `assistant-${input.assistantId}`, 'assistant.created');
  const details = assistantDetails.parse(assistant.data);
  if (details.kind !== 'team') return;
  if (!details.payingGroupId || input.payingGroupId !== details.payingGroupId) {
    throw new PayingGroupRefused('Paying group must match the assistant');
  }
  const fresh = await authorityFence(options.store, performance.now(),
    [`assistant-${input.assistantId}`, `member-${memberId}`]);
  await sharedAssistantAuthority(options, memberId, input.assistantId, details.payingGroupId, fresh);
  return fresh;
}

function chatRefusal(reply: FastifyReply, error: unknown) {
  if (error instanceof AuthorityApplying) return reply.code(503).send({ status: 'unavailable' });
  if (error instanceof GroupRefused) return reply.code(403).send({ status: 'refused' });
  if (error instanceof PayingGroupRefused) {
    return reply.code(403).send({ status: 'refused', error: error.message });
  }
  if (error instanceof Error && error.message === 'Phase 2 supports only agent_session conversations') {
    return reply.code(400).send({ status: 'refused', error: error.message });
  }
  return reply.code(error instanceof z.ZodError ? 400 : 409).send({ status: 'refused' });
}

function trustedRequest(request: FastifyRequest, config: AuthConfig,
  options: ChatOptions, orgId: string | undefined) {
  if (orgId !== config.expectedOrgId || options.silo !== options.binding.silo) return false;
  if (request.method !== 'POST') return true;
  return request.headers.origin === new URL(config.redirectUri).origin;
}
