import type { EventStore, StoredEvent } from '@opencrane/event-store';

export async function history(store: Pick<EventStore, 'readStream'>,
  subject: string, silo: string, deadline = Infinity) {
  const rows = [];
  for await (const row of store.readStream(subject, 1, deadline)) {
    if (row.event.silo !== silo) throw new Error('Wrong silo');
    rows.push(row);
  }
  if (subject.startsWith('conversation-')) {
    const conversationId = subject.slice('conversation-'.length);
    for await (const row of store.readStream(`participation-${conversationId}`, 1, deadline)) {
      if (row.event.silo !== silo) throw new Error('Wrong silo');
      if (row.event.type === 'conversation.closed') rows.push(row);
    }
    rows.sort(compareEventPosition);
  }
  return rows;
}
function compareEventPosition(first: StoredEvent, second: StoredEvent) {
  return first.sequence - second.sequence;
}
