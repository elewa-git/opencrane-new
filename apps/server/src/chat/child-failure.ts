import { createHash } from 'node:crypto';
import { childStartFailedEventSchema, type ChildRequest } from '@opencrane/events';
import type { StoredEvent } from '@opencrane/event-store';
import type { ChatOptions } from './access.ts';
import { chatHistory } from './commands.ts';

export function childStartFailure(rows: StoredEvent[], intentEventId: string) {
  for (const row of rows) {
    if (row.event.type !== 'conversation.child_start_failed') continue;
    const event = childStartFailedEventSchema.parse(row.event);
    if (event.data.intentEventId === intentEventId) return event;
  }
  return undefined;
}
export async function recordChildStartFailure(options: Pick<ChatOptions, 'store' | 'silo'>,
  intentEventId: string, intent: ChildRequest, stage: 'create' | 'first_input',
  reason: 'access_refused' | 'conversation_closed' | 'record_changed') {
  const rows = await chatHistory(options.store, options.silo, intent.conversationId);
  if (childStartFailure(rows, intentEventId)) return;
  const subject = `conversation-${intent.conversationId}`;
  let sequence = 0;
  for (const row of rows) {
    if (row.event.subject === subject) sequence = row.sequence;
  }
  const hash = createHash('sha256');
  hash.update(JSON.stringify([options.silo, intent.conversationId, intent.requestId, 1]));
  const id = `child-failure-${hash.digest('hex')}`;
  const event = { id, commandId: id, subject, type: 'conversation.child_start_failed',
    silo: options.silo, source: 'opencrane-server', time: new Date().toISOString(),
    principal: { kind: 'system', id: 'opencrane-server' },
    data: { conversationId: intent.conversationId, requestId: intent.requestId,
      childConversationId: intent.childConversationId, intentEventId, attempt: 1, stage, reason } };
  // Save the outcome even after close. This grants no permission to resume the child.
  const command = { event, expectedSequence: sequence, historyChecked: true as const };
  const result = await options.store.append(command);
  if (result.status !== 'appended') throw new Error('Child failure outcome unavailable');
}
