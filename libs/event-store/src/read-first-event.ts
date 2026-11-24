import type { EventStore } from './jetstream.ts';
import type { StoredEvent } from './contract.ts';

export class FirstEventRefused extends Error {
  constructor() {
    super('Creation history unavailable');
  }
}

export type FirstEventRead = {
  silo: string;
  subject: string;
  type: string;
  deadline: number;
  position?: number;
};

type FirstPosition = { sequence: number; eventId: string };
const positions = new WeakMap<object, Map<string, FirstPosition>>();

function firstPositions(store: object) {
  let entries = positions.get(store);
  if (!entries) {
    entries = new Map();
    positions.set(store, entries);
  }
  return entries;
}

function remember(entries: Map<string, FirstPosition>, key: string, row: StoredEvent) {
  entries.delete(key);
  entries.set(key, { sequence: row.sequence, eventId: row.event.id });
  if (entries.size > 64) {
    const oldest = entries.keys().next().value;
    if (oldest !== undefined) entries.delete(oldest);
  }
}

/** Recheck one immutable creation event, using its saved position on later reads. */
export async function readFirstEvent(store: Pick<EventStore, 'readStream'>,
  request: FirstEventRead): Promise<StoredEvent> {
  const entries = firstPositions(store);
  const key = JSON.stringify([request.silo, request.subject]);
  const saved = entries.get(key);
  const through = request.position ?? saved?.sequence;
  const from = saved?.sequence ?? 1;
  let creation: StoredEvent | undefined;
  const rows = store.readStream(request.subject, from, request.deadline, false, through);
  for await (const row of rows) {
    if (creation) throw new FirstEventRefused();
    requireCreation(row, request, saved, through);
    creation = row;
    // Stop after one row when the caller has no indexed upper position.
    if (request.position === undefined) break;
  }
  if (!creation) throw new FirstEventRefused();
  remember(entries, key, creation);
  return creation;
}

function requireCreation(row: StoredEvent, request: FirstEventRead,
  saved: FirstPosition | undefined, through: number | undefined) {
  if (row.event.silo !== request.silo || row.event.subject !== request.subject ||
      row.event.type !== request.type) {
    throw new FirstEventRefused();
  }
  if (through !== undefined && row.sequence !== through) {
    throw new FirstEventRefused();
  }
  if (saved && row.event.id !== saved.eventId) {
    throw new FirstEventRefused();
  }
}
