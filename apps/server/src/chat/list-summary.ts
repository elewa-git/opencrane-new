import { z } from 'zod';
import { sessionSlug } from '@opencrane/protocol';
import type { ChatOptions } from './access.ts';
import { requirePublicHistory } from './history.ts';

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
export async function summary(options: ChatOptions, conversationId: string, mode: string,
  joinPosition: number) {
  await requirePublicHistory(options, conversationId);
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
  const saved = await options.db.query<{ closed: boolean }>(
    'SELECT closed FROM conversations WHERE silo=$1 AND conversation_id=$2',
    [options.silo, conversationId]);
  const first = result.rows.find(isFirstMessage);
  const last = result.rows.findLast(changesStatus);
  let title = 'New session';
  if (first) title = sessionSlug(options.keys.decrypt(options.silo, conversationId, first.data));
  let status = conversationStatus(result.rows, last, mode);
  if (saved.rows[0]?.closed) status = 'closed';
  return { title, status };
}
