import { chatDisplayData, hasDisplayText } from './display.ts';
import { participantCommand, participantList } from './participants.ts';
import { PayingGroupRefused, isAuthorityChanged } from '@opencrane/models';
import { creationEvent, privateSessionReader, sharedAssistantAuthority,
  writePrivateSession } from './private-session.ts';
import { summary } from './list-summary.ts';
import { childOrigin } from './origin.ts';
import { conversationListQuery, conversationListCursor, ConversationListChanged,
  ConversationListIncomplete }
  from './list-cursor.ts';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { AuthConfig } from '@opencrane/auth';
import { memberAuthorisation } from '@opencrane/authz';
import {
  conversationListCandidates, conversationListRevision, readConversation,
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
import { requireMember, MemberRefusal, idSchema } from '../members/guard.ts';
import { colleagues, chatChange } from './reads.ts';
import { chatCommand, chatInput, ChatConflict } from './commands.ts';
import { chatGroups, chatGroupSnapshot, reviewedGroup, GroupSnapshotTooLarge } from './groups.ts';
import { memoryAdmission } from './memory-admission.ts';
import { stateCommand, stateChange, listPreference } from './state.ts';

export type { ChatOptions } from './access.ts';
type Access = Awaited<ReturnType<typeof chatAccess>>;
type Fresh = Awaited<ReturnType<typeof writeChatAccess>>;
const id = idSchema;
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
    const data = chatDisplayData(row.type, row.data);
    const saved = z.record(z.string(), z.unknown()).parse(row.data);
    if (!hasDisplayText(row.type) || !('ciphertext' in saved)) return { ...row, data };
    const text = options.keys.decrypt(options.silo, conversationId, saved);
    return { ...row, data: { ...data, text } };
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
  app.get('/api/conversations/:conversationId/origin', handler);
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
  const stateRoute = { method: 'POST' as const, url: '/api/conversations/:conversationId/state',
    bodyLimit: 4096, handler };
  app.route(stateRoute);
  async function handler(request: FastifyRequest, reply: FastifyReply) {
    reply.header('cache-control', 'no-store');
    try {
      const { conversationId, commandId } = parameters.parse(request.params);
      const participants = request.routeOptions.url === participantsRoute.url;
      const origin = request.routeOptions.url === '/api/conversations/:conversationId/origin';
      if (origin) {
        const checks = { write: false };
        const context = await requireMember(request, reply, config, options, checks);
        const result = await childOrigin(context.options, context.memberId,
          idSchema.parse(conversationId));
        return reply.send(result);
      }
      const preferences = request.routeOptions.url === stateRoute.url;
      let accessConversationId = conversationId;
      // Keep participant access in its existing read and command functions.
      if (participants || preferences) accessConversationId = undefined;
      const checks = { write: request.method === 'POST', conversationId: accessConversationId,
        allowApplying: commandId !== undefined };
      const context = await requireMember(request, reply, config, options, checks);
      const { memberId, access } = context;
      const configured = context.options;
      if (participants) {
        const participantConversationId = idSchema.parse(conversationId);
        return await participantReply(request, reply, configured, memberId,
          participantConversationId);
      }
      if (preferences) {
        const result = await stateCommand(configured, memberId,
          idSchema.parse(conversationId), request.body);
        return reply.code(appendStatusCode(result)).send(result.status === 'appended'
          ? result : { status: result.status });
      }
      if (request.method === 'GET') {
        let result;
        if (conversationId && commandId) {
          const preference = await stateChange(configured, memberId, conversationId,
            commandId, idSchema.parse(access.joinEventId));
          result = preference ?? await chatChange(configured, conversationId,
            commandId, access.historyPosition);
        } else {
          result = await read(request, configured, memberId, conversationId,
            access, config.cookieSecret);
        }
        if ('status' in result && result.status === 'not_found') reply.code(404);
        return reply.send(result);
      }
      const result = await write(request, configured, memberId, conversationId);
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

async function read(
  request: FastifyRequest, options: ChatOptions, memberId: string,
  conversationId: string | undefined, access: Access, secret: string,
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
    return chatRows(options, conversationId, mode, since, access.historyPosition);
  }
  return conversationList(options, memberId, request.query, secret);
}

type ListQuery = z.infer<typeof conversationListQuery>;
type ListCandidate = Awaited<ReturnType<typeof conversationListCandidates>>[number];

async function visibleListMatches(options: ChatOptions, memberId: string,
  query: ListQuery, candidates: ListCandidate[]) {
  const visibleCandidates: typeof candidates = [];
  const readPrivate = privateSessionReader(options, memberId);
  const readParticipation = conversationParticipationReader(options, memberId);
  async function authorisedSummary(candidate: (typeof candidates)[number]) {
    const row = candidate.conversation;
    try {
      const access = await readParticipation(row.conversationId);
      if (access.joinEventId !== candidate.joinEventId) throw new ConversationListChanged();
      if (row.mode === 'agent_session' && !('contextKind' in access.created)) {
        await readPrivate(row.conversationId, access.creation.event);
      }
      if (access.accessPosition !== candidate.participationPosition) {
        throw new ConversationListChanged();
      }
      visibleCandidates.push(candidate);
      const preference = listPreference(access.joinEventId, candidate.state);
      const archived = preference.archived;
      if (archived !== (query.section === 'archived')) return undefined;
      const display = await summary(options, row.conversationId, row.mode, access.historyPosition);
      const details = { ...display, ...preference };
      const normalisedSearch = query.q.normalize('NFC');
      const search = normalisedSearch.toLowerCase();
      const normalisedTitle = display.title.normalize('NFC');
      const searchableTitle = normalisedTitle.toLowerCase();
      if (!searchableTitle.includes(search)) return undefined;
      // Use the current join time when this person cannot read earlier history.
      let createdAt = row.createdAt;
      if (access.historyPosition > access.creation.sequence) {
        createdAt = candidate.joinedAt;
      }
      if (row.mode !== 'agent_session') {
        // Return current people and join time without details from an earlier creation.
        if (access.historyPosition > access.creation.sequence) {
          return { conversationId: row.conversationId, mode: row.mode,
            createdAt, participantIds: access.participantIds, ...details };
        }
        return { ...row, participantIds: access.participantIds, ...details };
      }
      const { conversationId, mode, assistantId, payingGroupId, createdBy, assistantKind } = row;
      return { conversationId, mode, assistantId, payingGroupId, createdBy, assistantKind,
        createdAt, ...details };
    } catch (error) {
      if (isChatRefused(error) || error instanceof ChatAccessApplying) return undefined;
      throw error;
    }
  }
  const matches = [];
  for (let offset = 0; offset < candidates.length; offset += 8) {
    const batch = candidates.slice(offset, offset + 8);
    const checks = batch.map(authorisedSummary);
    const summaries = await Promise.all(checks);
    for (let index = 0; index < summaries.length; index++) {
      const row = summaries[index];
      const candidate = batch[index];
      if (row && candidate) matches.push({ row, position: candidate.scanPosition });
    }
  }
  // Restore activity order after concurrent access checks finish in a different order.
  const visibleIds = new Set<string>();
  for (const candidate of visibleCandidates) visibleIds.add(candidate.conversation.conversationId);
  function isVisible(candidate: (typeof candidates)[number]) {
    return visibleIds.has(candidate.conversation.conversationId);
  }
  const authorised = candidates.filter(isVisible);
  return { matches, authorised, isVisible };
}

async function conversationList(options: ChatOptions, memberId: string,
  input: unknown, secret: string) {
  const query = conversationListQuery.parse(input);
  const candidates = await conversationListCandidates(options.db, options.silo, memberId);
  // Refuse a partial scan without returning rows or positions from denied chats.
  if (candidates.length === 100) throw new ConversationListIncomplete();
  const visible = await visibleListMatches(options, memberId, query, candidates);
  const { matches, authorised, isVisible } = visible;
  const revision = await conversationListRevision(options.db, authorised);
  const identity = [options.silo, memberId, query.section, query.q, query.limit, revision];
  const cursor = conversationListCursor(secret, identity, query.cursor);
  const currentCandidates = await conversationListCandidates(options.db, options.silo, memberId);
  if (currentCandidates.length === 100) throw new ConversationListIncomplete();
  const currentVisible = currentCandidates.filter(isVisible);
  const currentRevision = await conversationListRevision(options.db, currentVisible);
  if (currentRevision !== revision) throw new ConversationListChanged();
  function beforeCursor(match: (typeof matches)[number]) {
    const [activity, joined] = match.position;
    const [beforeActivity, beforeJoined] = cursor.before;
    return activity < beforeActivity || (activity === beforeActivity && joined < beforeJoined);
  }
  const remaining = matches.filter(beforeCursor);
  const page = remaining.slice(0, query.limit);
  function summaryRow(match: (typeof matches)[number]) {
    return match.row;
  }
  const rows = page.map(summaryRow);
  let nextCursor: string | null = null;
  if (remaining.length > page.length) {
    const lastVisible = page.at(-1);
    if (!lastVisible) throw new Error('Conversation page unavailable');
    nextCursor = cursor.next(lastVisible.position);
  }
  return { rows, nextCursor };
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
  if (error instanceof MemberRefusal) {
    return reply.code(error.statusCode).send({ status: error.status });
  }
  if (error instanceof ConversationListIncomplete) {
    return reply.code(503).send({ status: 'list_incomplete' });
  }
  if (error instanceof ConversationListChanged) {
    return reply.code(409).send({ status: 'list_changed' });
  }
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
