import { readEventAt } from '@opencrane/event-store';
import { chatAccess } from '../chat/access.ts';
import { MemoryRefused, type MemoryOptions } from './access.ts';

export async function messageAccess(options: MemoryOptions, requester: string,
  source: { conversationId: string; messageId: string }) {
  if (!options.chat) {
    throw new Error('Source access unavailable');
  }
  await chatAccess(options.chat, { memberId: requester, conversationId: source.conversationId });
  const deadline = performance.now() + 1000;
  const subject = `conversation-${source.conversationId}`;
  const position = await options.store.head(subject, deadline);
  const checkpoint = await options.db.query<{ sequence: string }>(
    "SELECT sequence FROM projection_checkpoints WHERE name='conversations'");
  if (Number(checkpoint.rows[0]?.sequence ?? -1) < position) {
    throw new Error('Source messages are still being updated');
  }
  const result = await options.db.query<{ position: string }>(`
    SELECT position FROM conversation_feed WHERE silo=$1 AND conversation_id=$2
      AND ((type='message.posted' AND event_id=$3)
        OR (type='agent.message_completed' AND data->>'messageId'=$3)) LIMIT 1`,
    [options.silo, source.conversationId, source.messageId]);
  const candidate = result.rows[0];
  if (!candidate) {
    throw new MemoryRefused();
  }
  // Check the saved event too. A read-table rebuild must never invent a source message.
  const row = await readEventAt(options.store, subject, Number(candidate.position), deadline);
  if (!row || row.event.silo !== options.silo) {
    throw new Error('Source message unavailable');
  }
  const event = row.event;
  if (event.type === 'message.posted' && event.id === source.messageId) {
    return;
  }
  if (event.type === 'agent.message_completed' && typeof event.data === 'object' &&
      event.data !== null && 'messageId' in event.data && event.data.messageId === source.messageId) {
    return;
  }
  throw new MemoryRefused();
}
