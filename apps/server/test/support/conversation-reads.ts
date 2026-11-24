import type { EventStore, StoredEvent } from '@opencrane/event-store';
import { vi } from 'vitest';

export function countConversationReads(store: EventStore, subject: string) {
  const read = store.readStream.bind(store);
  const readEvent = store.readEvent.bind(store);
  const counts = { events: 0, conversationEvents: 0, conversationReadMs: 0 };
  function countEvent(row: StoredEvent) {
    counts.events++;
    if (row.event.subject === subject) {
      counts.conversationEvents++;
    }
  }
  async function* measuredRead(...args: Parameters<typeof read>) {
    const started = performance.now();
    try {
      for await (const row of read(...args)) {
        countEvent(row);
        yield row;
      }
    } finally {
      if (args[0] === subject) {
        counts.conversationReadMs += performance.now() - started;
      }
    }
  }
  async function measuredEvent(...args: Parameters<typeof readEvent>) {
    const started = performance.now();
    const row = await readEvent(...args);
    countEvent(row);
    if (row.event.subject === subject) {
      counts.conversationReadMs += performance.now() - started;
    }
    return row;
  }
  const streamObserver = vi.spyOn(store, 'readStream');
  streamObserver.mockImplementation(measuredRead);
  const eventObserver = vi.spyOn(store, 'readEvent');
  eventObserver.mockImplementation(measuredEvent);
  return counts;
}
