import { z } from 'zod';
import { memberAuthorisation } from '@opencrane/authz';
import { activeMember } from '../members/groups.ts';
import { chatHistory } from './commands.ts';
import { isChatRefused, type chatAccess } from './access.ts';
import type { ChatOptions } from './access.ts';

type Fresh = Awaited<ReturnType<typeof chatAccess>>;
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
      await activeMember(options.store, options.binding, row.member_id);
      return { memberId: row.member_id, displayName: row.display_name };
    } catch (error) {
      if (isChatRefused(error)) return undefined;
      if (error instanceof Error && error.message === 'Authority changed') return undefined;
      throw error;
    }
  }
  const candidates = await Promise.all(page.map(candidate));
  const rows = [];
  for (const row of candidates) {
    if (row) rows.push(row);
  }
  let next: string | null = null;
  if (result.rows.length > input.limit) next = page.at(-1)?.member_id ?? null;
  return { rows, next };
}

export async function chatChange(
  options: ChatOptions, conversationId: string, commandId: string, fresh: Fresh,
) {
  const rows = await chatHistory(options.store, options.silo, conversationId, fresh.deadline);
  function matchesCommand(row: (typeof rows)[number]) {
    return row.event.commandId === commandId;
  }
  const row = rows.find(matchesCommand);
  if (!row) return { status: 'not_found' as const };
  const checkpoint = await options.db.query<{ sequence: string }>(
    'SELECT sequence FROM projection_checkpoints WHERE name = $1', ['conversations']);
  let content = 'applying';
  if (Number(checkpoint.rows[0]?.sequence ?? 0) >= row.sequence) content = 'current';
  let iam = 'current';
  if (row.event.type === 'conversation.created') {
    const applied = await memberAuthorisation(options.binding).applied(row.event.id);
    if (!applied) iam = 'applying';
  }
  return {
    status: 'appended' as const, conversationId, commandId, type: row.event.type,
    sequence: row.sequence, projection: { content, iam },
  };
}
