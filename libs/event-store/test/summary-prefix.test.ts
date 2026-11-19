import { expect, it } from 'vitest';
import { peekStreamSummary, readStreamSummary, systemClock, type StoredEvent, type SummaryKind }
  from '../src/index.ts';
import { event } from './testing.ts';

const kind: SummaryKind<StoredEvent[]> = {
  name: 'prefix-test', keep: 2, empty, add,
};
function empty(): StoredEvent[] {
  return [];
}
function add(rows: StoredEvent[], row: StoredEvent) {
  rows.push(row);
}
function copy(rows: StoredEvent[]) {
  return [...rows];
}

async function onlyReturnsCompletePrefix() {
  let reads = 0;
  async function* readStream() {
    reads++;
    const row = { sequence: 2, event: event('creation') };
    yield await Promise.resolve(row);
  }
  const store = { readStream, clock: systemClock };
  expect(peekStreamSummary(store, 'test', 'member-alice', kind, 2)).toBeUndefined();
  expect(reads).toBe(0);
  const rows = await readStreamSummary(store, 'test', 'member-alice', kind, Infinity, copy);
  const ready = peekStreamSummary(store, 'test', 'member-alice', kind, 2);
  expect(ready).toEqual({ summary: rows, sequence: 2 });
  expect(peekStreamSummary(store, 'test', 'member-alice', kind, 3)).toBeUndefined();
  expect(peekStreamSummary(store, 'other', 'member-alice', kind, 2)).toBeUndefined();
  expect(reads).toBe(1);
}
it('returns only an already read complete prefix without starting more history reads',
  onlyReturnsCompletePrefix);
