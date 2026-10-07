import type { StoredEvent } from './contract.ts';
import { debuglog } from 'node:util';
import { readBeforeDeadline, type EventStore } from './jetstream.ts';

export interface SummaryKind<Summary> {
  name: string;
  keep: number;
  /** Limit the combined size of this kind's cached streams, as well as stream count. */
  budget?: { limit: number; size(summary: Summary): number };
  empty(): Summary;
  /** Check the row before changing the summary; leave it unchanged if this throws. */
  add(summary: Summary, row: StoredEvent): void;
}

export class WrongSiloError extends Error {
  constructor() {
    super('Stream silo mismatch');
    this.name = 'WrongSiloError';
  }
}

interface Entry<Summary> {
  summary: Summary;
  sequence: number;
  queue: Promise<void>;
  size: number;
}

type KindEntries = Map<string, Entry<unknown>>;
const stores = new WeakMap<object, Map<string, KindEntries>>();
const logRebuild = debuglog('opencrane-summary');

function entriesFor(store: object, name: string): KindEntries {
  let kinds = stores.get(store);
  if (!kinds) {
    kinds = new Map();
    stores.set(store, kinds);
  }
  let entries = kinds.get(name);
  if (!entries) {
    entries = new Map();
    kinds.set(name, entries);
  }
  return entries;
}

function entryFor<Summary>(store: object, silo: string, subject: string,
  kind: SummaryKind<Summary>): Entry<Summary> {
  const entries = entriesFor(store, kind.name);
  const key = JSON.stringify([silo, subject]);
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Each kind name has one summary shape.
  let entry = entries.get(key) as Entry<Summary> | undefined;
  if (!entry) {
    entry = { summary: kind.empty(), sequence: 0, queue: Promise.resolve(), size: 0 };
  }
  // Move this entry to the end so the first key is always the least recently used.
  entries.delete(key);
  entries.set(key, entry);
  while (entries.size > kind.keep) {
    const keys = entries.keys();
    const oldest = keys.next().value;
    if (oldest === undefined) break;
    entries.delete(oldest);
  }
  return entry;
}

function applyBudget<Summary>(store: object, kind: SummaryKind<Summary>, entry: Entry<Summary>) {
  if (!kind.budget) return;
  entry.size = kind.budget.size(entry.summary);
  const entries = entriesFor(store, kind.name);
  if (entry.size > kind.budget.limit) {
    // Drop only this entry: removing other streams cannot make an oversized entry fit.
    for (const [key, cached] of entries) {
      if (cached === entry) {
        entries.delete(key);
      }
    }
    return;
  }
  let retainedSize = 0;
  for (const cached of entries.values()) retainedSize += cached.size;
  for (const [key, cached] of entries) {
    if (retainedSize <= kind.budget.limit) break;
    entries.delete(key);
    retainedSize -= cached.size;
  }
}

function finished(): void {
  // Release the queue after success or failure; the caller receives the original error.
}

export function readStreamSummary<Summary, Result>(
  store: Pick<EventStore, 'readStream'>, silo: string, subject: string,
  kind: SummaryKind<Summary>, deadline: number,
  take: (summary: Summary, sequence: number) => Result,
): Promise<Result> {
  const entry = entryFor(store, silo, subject, kind);
  async function catchUp() {
    if (entry.sequence === 0) {
      logRebuild('Rebuilding %s summary for %s in silo %s', kind.name, subject, silo);
    }
    const catchUpDeadline = Math.max(deadline, performance.now() + 10_000);
    const rows = store.readStream(subject, entry.sequence + 1, catchUpDeadline);
    try {
      for await (const row of rows) {
        if (row.event.silo !== silo) throw new WrongSiloError();
        kind.add(entry.summary, row);
        entry.sequence = row.sequence;
      }
      // Copy facts only after this call's own read reaches the head. Keep both in one slot.
      return take(entry.summary, entry.sequence);
    } finally {
      // Drop whole summaries, including partial reads, rather than forgetting refusal facts.
      applyBudget(store, kind, entry);
    }
  }
  const result = entry.queue.then(catchUp);
  entry.queue = result.then(finished, finished);
  if (deadline === Infinity) return result;
  function readResult() {
    return result;
  }
  return readBeforeDeadline(readResult, deadline);
}
