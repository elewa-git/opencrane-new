import { z } from 'zod';
import { memberAuthorisation } from '@opencrane/authz';
import { activeChatMember, isChatRefused } from './access.ts';
import type { ChatOptions } from './access.ts';

const colleagueQuery = z.object({
  after: z.string().regex(/^[\w-]{1,200}$/u).default(''),
  q: z.string().trim().max(100).default(''),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export async function colleagues(options: ChatOptions, memberId: string, query: unknown) {
  const input = colleagueQuery.parse(query);
  const result = await options.db.query<{ member_id: string; display_name: string | null }>(
    `SELECT member_id, display_name FROM members
      WHERE silo = $1 AND status = 'joined' AND member_id <> $2 AND member_id > $3
      AND ($4 = '' OR strpos(lower(coalesce(display_name, '')), lower($4)) > 0)
      ORDER BY member_id LIMIT $5`,
    [options.silo, memberId, input.after, input.q, input.limit + 1]);
  const page = result.rows.slice(0, input.limit);
  async function candidate(row: (typeof page)[number]) {
    try {
      await activeChatMember(options, row.member_id);
      return { memberId: row.member_id, displayName: row.display_name };
    } catch (error) {
      if (isChatRefused(error)) return undefined;
      throw error;
    }
  }
  const checks = page.map(candidate);
  const candidates = await Promise.all(checks);
  const rows = [];
  for (const row of candidates) {
    if (row) rows.push(row);
  }
  let next: string | null = null;
  if (result.rows.length > input.limit) next = page.at(-1)?.member_id ?? null;
  return { rows, next };
}

export async function chatChange(
  options: ChatOptions, conversationId: string, commandId: string, joinPosition = 0,
) {
  const result = await options.db.query<{ event_id: string; type: string; position: string }>(
    `SELECT event_id, type, position FROM conversation_feed
      WHERE silo = $1 AND conversation_id = $2 AND event_id = $3 AND position >= $4`,
    [options.silo, conversationId, commandId, joinPosition]);
  const row = result.rows[0];
  if (!row) return { status: 'not_found' as const };
  let iam = 'current';
  if (row.type === 'conversation.created') {
    const applied = await memberAuthorisation(options.binding).applied(row.event_id);
    if (!applied) iam = 'applying';
  }
  return {
    status: 'appended' as const, conversationId, commandId, type: row.type,
    sequence: Number(row.position), projection: { content: 'current', iam },
  };
}
