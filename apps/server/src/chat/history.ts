import { z } from 'zod';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { isOrganisationSession, type AuthConfig } from '@opencrane/auth';
import { readConversation } from '@opencrane/projections';
import { requireMember, MemberRefusal } from '../members/guard.ts';
import { sessionFor } from '../members/routes.ts';
import { legacyParticipation, participation } from './participation.ts';
import { ChatRefused, type ChatOptions } from './access.ts';
import { chatDisplayData, hasDisplayText } from './display.ts';

type History = Awaited<ReturnType<typeof readConversation>>;

export async function chatRows(options: ChatOptions, conversationId: string,
  mode: 'agent_session' | 'direct' | 'group', since = 0, joinPosition = 0) {
  const visibleSince = Math.max(since, joinPosition - 1);
  const result = await readConversation(options.db, options.silo, conversationId, visibleSince);
  return displayHistory(options, conversationId, mode, result);
}

async function displayHistory(options: ChatOptions, conversationId: string,
  mode: 'agent_session' | 'direct' | 'group', result: History) {
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

export async function chatHistoryReply(request: FastifyRequest, reply: FastifyReply,
  config: AuthConfig, options: ChatOptions | undefined, conversationId: string) {
  const session = sessionFor(request, config, new Date());
  if (!session) throw new MemberRefusal(401, 'refused');
  if (!options || !options.silo || !config.expectedOrgId) {
    throw new MemberRefusal(503, 'unavailable');
  }
  if (!isOrganisationSession(config, session) || options.silo !== options.binding.silo) {
    throw new MemberRefusal(403, 'refused');
  }
  const memberId = await options.feed.memberId(options.silo, config.issuerUrl, session.sub);
  if (!memberId) throw new MemberRefusal(403, 'refused');
  const query = z.object({ since: z.coerce.number().int().nonnegative().default(0) });
  const { since } = query.parse(request.query);
  let loaded: Awaited<ReturnType<typeof loadHistory>> | undefined;
  let loadingError: Error | undefined;
  try {
    loaded = await loadHistory(options, conversationId, memberId, since);
  } catch (error) {
    loadingError = new Error('Conversation history unavailable', { cause: error });
  }
  // Check current access once, after loading and before decrypting any text.
  const checks = { write: false, conversationId };
  const { access } = await requireMember(request, reply, config, options, checks);
  if (loadingError) throw loadingError;
  if (!loaded || access.joinEventId !== loaded.joinEventId) {
    throw new ChatRefused('Conversation participation changed');
  }
  const result = await displayHistory(options, conversationId, loaded.mode, loaded.result);
  return reply.send(result);
}

async function loadHistory(options: ChatOptions, conversationId: string,
  memberId: string, since: number) {
  const deadline = performance.now() + 10_000;
  // Load only the join facts here. They bound history but do not grant access.
  const legacy = await legacyParticipation(options.store, options.db, options.silo,
    conversationId, deadline);
  const facts = await participation(options.store, options.silo, conversationId,
    memberId, legacy, deadline);
  const visibleSince = Math.max(since, facts.historyPosition - 1);
  const result = await readConversation(options.db, options.silo, conversationId, visibleSince);
  if (performance.now() >= deadline) throw new Error('Conversation history unavailable');
  return { result, joinEventId: facts.joinEventId, mode: facts.created.mode };
}
