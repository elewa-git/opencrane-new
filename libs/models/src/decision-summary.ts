import type { StoredEvent, SummaryKind } from '@opencrane/event-store';
import { outputReportTypes } from './authority.ts';
import { data } from './state.ts';

function emptyChat(): StoredEvent[] {
  return [];
}

function addChat(summary: StoredEvent[], row: StoredEvent) {
  if (outputReportTypes.includes(row.event.type)) return;
  if (row.event.type === 'message.posted') {
    // Keep the event for approval checks without retaining its encrypted text.
    const conversationId = data(row.event)['conversationId'];
    const event = { ...row.event, data: { conversationId } };
    const message = { sequence: row.sequence, event };
    summary.push(message);
    return;
  }
  summary.push(row);
}

export const decisionChatSummary: SummaryKind<StoredEvent[]> = {
  name: 'decision-chat', keep: 64, empty: emptyChat, add: addChat,
  budget: { limit: 30_000, size: chatSize },
};
function chatSize(summary: StoredEvent[]) {
  return summary.length;
}
