import { chatFeedSchema, type ChatRow } from '@opencrane/protocol';
import { requestChat } from './chat-session-http';

type ChatFeed = ReturnType<typeof chatFeedSchema.parse>;

export interface ReplacementHistory {
  rows: ChatRow[];
  position: number;
  feed: ChatFeed;
}

export async function readReplacementHistory(
  conversationId: string, isCurrent: () => boolean,
): Promise<ReplacementHistory | undefined> {
  let position = 0;
  let generation = 0;
  const rows: ChatRow[] = [];
  while (true) {
    const path = `/api/conversations/${conversationId}/messages?since=${position}`;
    const feed = chatFeedSchema.parse(await requestChat(path));
    if (!isCurrent()) return undefined;
    if (position > 0 && feed.generation !== generation) {
      // Start again when the server replaces its saved view during paging.
      position = 0;
      rows.length = 0;
      generation = feed.generation;
      continue;
    }
    generation = feed.generation;
    for (const row of feed.rows) {
      if (row.position <= position) continue;
      rows.push(row);
      position = row.position;
    }
    if (feed.rows.length === 0 || position >= feed.position) {
      return { rows, position, feed };
    }
  }
}
