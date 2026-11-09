import type { EventStore } from './jetstream.ts';

async function advancedAtSnapshot(store: EventStore, subject: string, position: number,
  snapshot: number, deadline: number) {
  if (!Number.isSafeInteger(position) || position < 0 || position > snapshot) {
    throw new Error('Invalid event position');
  }
  for await (const row of store.readStream(subject, position + 1, deadline)) {
    return row.sequence <= snapshot;
  }
  return false;
}

/** Check several subjects at one position in the append-only event log. */
export async function snapshotPositions(store: EventStore,
  positions: ReadonlyMap<string, number>, deadline = Infinity) {
  const snapshot = await store.head(undefined, deadline);
  for (const [subject, position] of positions) {
    if (await advancedAtSnapshot(store, subject, position, snapshot, deadline)) {
      throw new Error('Event position changed');
    }
  }
  // Refuse a change while the separate subject reads were in progress.
  const current = await store.head(undefined, deadline);
  if (current !== snapshot) {
    throw new Error('Event position changed');
  }
  return snapshot;
}
