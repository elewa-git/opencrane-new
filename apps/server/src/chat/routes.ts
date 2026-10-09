import { chatIdSchema } from '@opencrane/events';
import { participantCommand, participantList } from './participants.ts';
import { PayingGroupRefused, isAuthorityChanged } from '@opencrane/models';
import { creationEvent, privateSessionReader, sharedAssistantAuthority,
  writePrivateSession } from './private-session.ts';
import { sessionSlug } from '@opencrane/protocol';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { isOrganisationSession, type AuthConfig } from '@opencrane/auth';
import { memberAuthorisation } from '@opencrane/authz';
import {
  listConversations, readConversation,
} from '@opencrane/projections';
import {
  chatAccess,
  writeChatAccess,
  activeChatMember,
  recordedChatMode,
  isChatRefused,
  ChatRefused,
  ChatAccessApplying,
  conversationParticipationReader,
  type ChatOptions,
} from './access.ts';
import { sessionFor } from '../members/routes.ts';
import { colleagues, chatChange } from './reads.ts';
import { chatCommand, chatInput, ChatConflict } from './commands.ts';
import { chatGroups, chatGroupSnapshot, reviewedGroup, GroupSnapshotTooLarge } from './groups.ts';
import { chatIdSchema } from '@opencrane/events';
import { memoryAdmission } from './memory-admission.ts';

export type { ChatOptions } from './access.ts';
type Access = Awaited<ReturnType<typeof chatAccess>>;
type Fresh = Awaited<ReturnType<typeof writeChatAccess>>;
const id = chatIdSchema;
const assistantDetails = z.object({
  kind: z.string(), payingGroupId: z.string().optional(),
});
class InvalidChatRequest extends Error {}
const parameters = z.object({ conversationId: id.optional(), commandId: id.optional() });

export async function chatRows(options: ChatOptions, conversationId: string,
  mode: 'agent_session' | 'direct' | 'group', since = 0, joinPosition = 0) {
  const visibleSince = Math.max(since, joinPosition - 1);
  const result = await readConversation(options.db, options.silo, conversationId, visibleSince);
  const computer = await conversationComputerState(options, conversationId, mode);
  function decryptRow(row: (typeof result.rows)[number]) {
    const data = z.record(z.string(), z.unknown()).parse(row.data);
    if (!('ciphertext' in data)) return row;
    const { ciphertext: _ciphertext, keyId: _keyId, ...rest } = data;
    const text = options.keys.decrypt(options.silo, conversationId, data);
    return { ...row, data: { ...rest, text } };
  }
  const rows = result.rows.map(decryptRow);
  return { ...result, ...computer, rows };
}

async function conversationComputerState(options: ChatOptions, conversationId: string,
  mode: 'agent_session' | 'direct' | 'group') {
  // Use the mode from the event log; the read table may still be catching up.
  if (mode !== 'agent_session') {
    return { computerState: 'not_applicable' as const, computerRecovered: false,
      computerLostAt: undefined };
  }
  const result = await options.db.query<{
    chat_state: 'ready' | 'starting' | 'recovering'; recovered: boolean; lost_at: string | null;
  }>(
    `SELECT c.chat_state, c.recovered, c.lost_at FROM conversation_feed f
      LEFT JOIN computers c ON c.silo = f.silo AND c.assistant_id = f.data->>'assistantId'
      WHERE f.silo = $1 AND f.conversation_id = $2 AND f.type = 'conversation.created'`,
    [options.silo, conversationId]);
  const computer = result.rows[0];
  return { computerState: computer?.chat_state ?? 'starting',
    computerRecovered: computer?.recovered ?? false, computerLostAt: computer?.lost_at ?? undefined };
}

export function registerChatRoutes(app: FastifyInstance, config: AuthConfig, options?: ChatOptions) {
  app.get('/api/chat', handler);
  app.get('/api/chat/colleagues', handler);
  app.get('/api/chat/groups', handler);
  app.get('/api/chat/groups/:groupId', handler);
  app.get('/api/conversations/:conversationId/changes/:commandId', handler);
  const conversationsRoute = {
    method: ['GET', 'POST'] as ('GET' | 'POST')[],
    url: '/api/conversations',
    bodyLimit: 32 * 1024,
    handler,
  };
  const messagesRoute = {
    method: ['GET', 'POST'] as ('GET' | 'POST')[],
    url: '/api/conversations/:conversationId/messages',
    handler,
  };
  app.route(conversationsRoute);
  app.route(messagesRoute);
  const participantsRoute = {
    method: ['GET', 'POST'] as ('GET' | 'POST')[],
    url: '/api/conversations/:conversationId/participants',
    bodyLimit: 4096,
    handler,
  };
  app.route(participantsRoute);
  async function handler(request: FastifyRequest, reply: FastifyReply) {
    reply.header('cache-control', 'no-store');
    const session = sessionFor(request, config, new Date());
    if (!session) return reply.code(401).send({ status: 'refused' });
    if (!options) return reply.code(503).send({ status: 'unavailable' });
    if (!trustedRequest(request, config, options, session)) {
      return reply.code(403).send({ status: 'refused' });
    }
    try {
      const memberId = await options.feed.memberId(options.silo, config.issuerUrl, session.sub);
      if (!memberId) throw new ChatRefused('Membership required');
      const { conversationId, commandId } = parameters.parse(request.params);
      if (request.routeOptions.url === participantsRoute.url) {
        const participantConversationId = chatIdSchema.parse(conversationId);
        return await participantReply(request, reply, options, memberId, participantConversationId);
      }
      const relation: 'post' | 'read' = request.method === 'POST' ? 'post' : 'read';
      const allowApplying = commandId !== undefined;
      const accessRequest = { memberId, conversationId, relation, allowApplying };
      const access = await chatAccess(options, accessRequest);
      if (request.method === 'GET') {
        let result;
        if (conversationId && commandId) {
          result = await chatChange(options, conversationId, commandId, access.joinPosition);
        } else {
          result = await read(request, options, memberId, conversationId, access);
        }
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

async function participantReply(request: FastifyRequest, reply: FastifyReply,
  options: ChatOptions, memberId: string, conversationId: string) {
  if (request.method === 'GET') {
    const result = await participantList(options, memberId, conversationId);
    return reply.send(result);
  }
  const result = await participantCommand(options, memberId, conversationId, request.body);
  const code = appendStatusCode(result);
  let response: unknown = { status: result.status };
  if (result.status === 'appended') response = result;
  return reply.code(code).send(response);
}

function trustedRequest(
  request: FastifyRequest, config: AuthConfig, options: ChatOptions,
  session: { sub: string; orgId: string },
) {
  if (!isOrganisationSession(config, session)) return false;
  if (options.silo !== options.binding.silo) return false;
  if (request.method !== 'POST') return true;
  return request.headers.origin === new URL(config.redirectUri).origin;
}

async function read(
  request: FastifyRequest, options: ChatOptions, memberId: string,
  conversationId: string | undefined, access: Access,
) {
  if (request.routeOptions.url === '/api/chat/colleagues') {
    return colleagues(options, memberId, request.query);
  }
  if (request.routeOptions.url === '/api/chat/groups') {
    return chatGroups(options, memberId, request.query);
  }
  if (request.routeOptions.url === '/api/chat/groups/:groupId') {
    const { groupId } = z.object({ groupId: id }).parse(request.params);
    return chatGroupSnapshot(options, memberId, groupId);
  }
  if (request.routeOptions.url === '/api/chat') return personalContext(options, memberId);
  if (conversationId) {
    const query = z.object({ since: z.coerce.number().int().nonnegative().default(0) });
    const { since } = query.parse(request.query);
    const mode = recordedChatMode(access);
    return chatRows(options, conversationId, mode, since, access.joinPosition);
  }
  return conversationList(options, memberId);
}

async function conversationList(options: ChatOptions, memberId: string) {
  const conversations = await listConversations(options.db, options.silo, memberId);
  const readPrivate = privateSessionReader(options, memberId);
  const readParticipation = conversationParticipationReader(options, memberId);
  async function authorisedSummary(row: (typeof conversations)[number]) {
    try {
      const access = await readParticipation(row.conversationId);
      if (row.mode === 'agent_session') {
        await readPrivate(row.conversationId, access.creation.event);
      }
      const display = await summary(options, row.conversationId, row.mode, access.joinPosition);
      if (row.mode !== 'agent_session') {
        return { ...row, participantIds: access.participantIds, ...display };
      }
      return { ...row, ...display };
    } catch (error) {
      if (isChatRefused(error) || error instanceof ChatAccessApplying) return undefined;
      throw error;
    }
  }
  const rows = [];
  for (let offset = 0; offset < conversations.length; offset += 16) {
    const batch = conversations.slice(offset, offset + 16);
    const checks = batch.map(authorisedSummary);
    const summaries = await Promise.all(checks);
    for (const row of summaries) {
      if (row) rows.push(row);
    }
  }
  return { rows };
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
  return { memberId, displayName: member.rows[0]?.display_name ?? null, assistantId,
    memoryAdmission };
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
function conversationStatus(rows: SummaryRow[], last: SummaryRow | undefined, mode: string) {
  if (last?.type === 'conversation.closed') return 'closed';
  if (mode !== 'agent_session' || !last) return 'open';
  if (last.type === 'agent.turn_failed') return 'failed';
  if (last.type === 'agent.turn_stop_requested') return 'stopped';
  if (last.type === 'agent.turn_completed') {
    const turnId = z.object({ turnId: z.string() }).parse(last.data).turnId;
    const outputWasLost = outputWasLostForTurn(rows, turnId);
    return outputWasLost ? 'lost' : 'done';
  }
  return 'working';
}
function outputWasLostForTurn(rows: SummaryRow[], turnId: string): boolean {
  for (const row of rows) {
    if (row.type !== 'agent.output_lost') continue;
    const lostTurnId = z.object({ turnId: z.string() }).parse(row.data).turnId;
    if (lostTurnId === turnId) return true;
  }
  return false;
}
async function summary(options: ChatOptions, conversationId: string, mode: string,
  joinPosition: number) {
  const result = await options.db.query<SummaryRow>(
    `WITH visible_first AS (
      SELECT type, data FROM conversation_feed WHERE silo = $1 AND conversation_id = $2
        AND position >= $3 AND type = 'message.posted' ORDER BY position LIMIT 1
    ), visible_last AS (
      SELECT type, data FROM conversation_feed WHERE silo = $1 AND conversation_id = $2
        AND position >= $3 AND type IN ('message.posted', 'agent.turn_started',
          'agent.turn_completed', 'agent.turn_failed', 'agent.turn_stop_requested',
          'conversation.closed') ORDER BY position DESC LIMIT 1
    ), lost_output AS (
      SELECT type, data FROM conversation_feed WHERE silo = $1 AND conversation_id = $2
        AND position >= $3 AND type = 'agent.output_lost'
        AND data->>'turnId' = (SELECT data->>'turnId' FROM visible_last) LIMIT 1
    ) SELECT * FROM visible_first UNION ALL SELECT * FROM visible_last
      UNION ALL SELECT * FROM lost_output`, [options.silo, conversationId, joinPosition]);
  const first = result.rows.find(isFirstMessage);
  const last = result.rows.findLast(changesStatus);
  let title = 'New session';
  if (first) title = sessionSlug(options.keys.decrypt(options.silo, conversationId, first.data));
  return { title, status: conversationStatus(result.rows, last, mode) };
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
  if ('assistantId' in input) {
    await assistantCreationDetails(options, memberId, input);
  }
  if ('mode' in input) options.keys.provision(options.silo, input.conversationId);
  async function checkFresh(operation: 'retry' | 'append') {
    // Check access just before the append; slow history reads have their own time limit.
    let snapshot;
    if (operation === 'append' && 'participantIds' in input) {
      snapshot = await reviewedGroup(options, memberId, input);
    }
    const request = { memberId, conversationId, relation: 'post' as const };
    const fresh = await writeChatAccess(options, request);
    await groupCreationAuthority(options, input, operation, fresh, snapshot);
    if ('assistantId' in input) {
      const payerFresh = await assistantCreation(options, memberId, input, fresh);
      await payerFresh?.();
    }
    let colleagueId = fresh.colleagueId;
    if ('colleagueId' in input) colleagueId = input.colleagueId;
    // Allow retries to report a saved result; require both people for new messages.
    if (operation === 'append' && colleagueId) {
      try {
        await activeChatMember(options, colleagueId, fresh);
      } catch (error) {
        if (isChatRefused(error) && !('colleagueId' in input)) {
          throw new ChatConflict('Other participant is no longer active');
        }
        throw error;
      }
    }
    if (!('mode' in input) && fresh.mode === 'agent_session' && conversationId) {
      const teamFresh = await writePrivateSession(
        options, memberId, conversationId, 'stopTurnId' in input);
      await teamFresh?.();
    }
    await confirmChatAccess(fresh, snapshot !== undefined);
    return fresh.deadline;
  }
  const context = { silo: options.silo, memberId };
  return chatCommand(options.store, options.keys, context, input, checkFresh);
}

async function groupCreationAuthority(options: ChatOptions,
  input: z.infer<typeof chatInput>, operation: 'retry' | 'append', fresh: Fresh,
  snapshot: Awaited<ReturnType<typeof reviewedGroup>>) {
  if (operation === 'retry' || !('participantIds' in input)) return;
  function activeParticipant(participantId: string) {
    return activeChatMember(options, participantId, fresh);
  }
  const checks = input.participantIds.map(activeParticipant);
  await Promise.all(checks);
  if (!snapshot) return;
  const subject = `team-${snapshot.groupId}`;
  fresh.include(subject);
  if (await options.store.head(subject, fresh.deadline) !== snapshot.position) {
    throw new ChatConflict('Group changed; review its members again');
  }
}

async function confirmChatAccess(fresh: Fresh, reviewedSnapshot: boolean) {
  try {
    await fresh();
  } catch (error) {
    if (reviewedSnapshot && isAuthorityChanged(error)) {
      throw new ChatConflict('Group changed; review its members again');
    }
    throw error;
  }
}

async function assistantCreation(
  options: ChatOptions, memberId: string,
  input: Extract<z.infer<typeof chatInput>, { assistantId: string }>, fresh: Fresh,
) {
  fresh.include(`assistant-${input.assistantId}`);
  const details = await assistantCreationDetails(options, memberId, input, fresh.deadline);
  if (details.kind !== 'team') return undefined;
  await sharedAssistantAuthority(options, memberId, input.assistantId,
    z.string().parse(details.payingGroupId), fresh);
  return fresh;
}

async function assistantCreationDetails(options: ChatOptions, memberId: string,
  input: { assistantId: string; payingGroupId?: string | undefined }, deadline?: number) {
  const auth = memberAuthorisation(options.binding);
  const permission = await auth.actsFor(memberId, input.assistantId);
  if (!permission.allowed) throw new ChatRefused('Assistant refused');
  const assistant = await creationEvent(options.store, options.silo,
    `assistant-${input.assistantId}`, 'assistant.created', deadline);
  const details = assistantDetails.parse(assistant.data);
  if (details.kind === 'team' &&
      (!details.payingGroupId || input.payingGroupId !== details.payingGroupId)) {
    throw new PayingGroupRefused('Paying group must match the assistant');
  }
  return details;
}

function chatRefusal(request: FastifyRequest, reply: FastifyReply, error: unknown) {
  if (error instanceof ChatAccessApplying) {
    return reply.code(425).send({ status: 'access_applying' });
  }
  if (error instanceof PayingGroupRefused) {
    return reply.code(403).send({ status: 'refused', error: error.message });
  }
  if (isChatRefused(error)) return reply.code(403).send({ status: 'refused' });
  if (error instanceof z.ZodError || error instanceof InvalidChatRequest) {
    return reply.code(400).send({ status: 'refused' });
  }
  if (error instanceof GroupSnapshotTooLarge) {
    return reply.code(409).send({ status: 'refused', error: error.message });
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
