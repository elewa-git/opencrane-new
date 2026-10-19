import type { EventStore, StoredEvent } from '@opencrane/event-store';

// Retain only the small access streams checked for this permit. Read later events
// from their saved positions, so repeated checks never replay an entire stream.
export function egressHistory(store: EventStore, silo: string) {
  const histories = new Map<string, StoredEvent[]>();
  const positions = new Map<string, number>();
  async function read(subject: string, deadline: number) {
    const to = await store.head(subject, deadline);
    const from = (positions.get(subject) ?? 0) + 1;
    const rows = histories.get(subject) ?? [];
    if (to < from - 1) throw new Error('Egress history unavailable');
    if (to >= from) {
      for await (const row of store.readStream(subject, from, deadline)) {
        if (row.sequence > to) break;
        if (row.event.silo !== silo) throw new Error('Egress history unavailable');
        rows.push(row);
      }
    }
    histories.set(subject, rows);
    positions.set(subject, to);
    return rows;
  }
  return { read, positions };
}
