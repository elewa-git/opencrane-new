import { TimeoutError } from '@nats-io/transport-node';
import { afterEach, expect, it, vi } from 'vitest';
import { readStreamSummary, WrongSiloError, type SummaryKind, type StoredEvent } from '../src/index.ts';
import { countReads, event, natsFixture } from './testing.ts';

let fixture: Awaited<ReturnType<typeof natsFixture>>;
async function close() {
  vi.useRealTimers();
  await fixture?.close();
}
afterEach(close);

function empty() {
  return { ids: [] as string[] };
}
function add(summary: ReturnType<typeof empty>, row: StoredEvent) {
  summary.ids.push(row.event.id);
}
const kind: SummaryKind<ReturnType<typeof empty>> = { name: 'ids', keep: 2, empty, add };
function take(summary: ReturnType<typeof empty>, sequence: number) {
  return { ids: [...summary.ids], sequence };
}
async function incrementalMatchesReplay() {
  fixture = await natsFixture();
  // Use a fixed random seed so every run exercises the same five cut points.
  let random = 210;
  let position = 0;
  const expectedIds: string[] = [];
  for (let cut = 0; cut < 5; cut++) {
    random = (random * 16807) % 2147483647;
    const count = random % 9 + 1;
    const events = [];
    for (let index = 0; index < count; index++) {
      const id = `event-${position++}`;
      expectedIds.push(id);
      events.push(event(id));
    }
    await fixture.seed(events);
    const incremental = await readStreamSummary(
      fixture.store, 'test', 'member-alice', kind, Infinity, take);
    const rows = await Array.fromAsync(fixture.store.readStream('member-alice'));
    const rebuilt = empty();
    for (const row of rows) add(rebuilt, row);
    expect(incremental).toEqual(take(rebuilt, position));
    expect(incremental).toEqual({ ids: [...expectedIds], sequence: position });
  }
  const reads = countReads(fixture.store);
  await readStreamSummary(fixture.store, 'test', 'member-alice', kind, Infinity, take);
  expect(reads.calls).toEqual([
    { subject: 'member-alice', fromSequence: position + 1, rows: 0 },
  ]);
}
it('adds only new events and equals a full replay at five random cut points',
  incrementalMatchesReplay);

async function serialisesFreshReads() {
  fixture = await natsFixture();
  await fixture.seed([event('first')]);
  const read = fixture.store.readStream.bind(fixture.store);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let calls = 0;
  async function* heldRead(subject: string, from = 1, deadline = Infinity) {
    calls++;
    const rows = await Array.fromAsync(read(subject, from, deadline));
    if (calls === 1) {
      entered.resolve();
      await release.promise;
    }
    yield* rows;
  }
  fixture.store.readStream = heldRead;
  const first = readStreamSummary(fixture.store, 'test', 'member-alice', kind, Infinity, take);
  await entered.promise;
  const second = readStreamSummary(fixture.store, 'test', 'member-alice', kind, Infinity, take);
  await fixture.seed([event('second')]);
  release.resolve();
  expect(await first).toEqual({ ids: ['first'], sequence: 1 });
  expect(await second).toEqual({ ids: ['first', 'second'], sequence: 2 });
  expect(calls).toBe(2);
}
it('queues a separate fresh read for each caller and never adds an event twice',
  serialisesFreshReads);

async function dropsLeastRecentlyUsed() {
  fixture = await natsFixture();
  await fixture.seed([event('alice'), event('bob', 'member-bob'), event('carol', 'member-carol')]);
  const reads = countReads(fixture.store);
  for (const member of ['alice', 'bob', 'alice', 'carol']) {
    await readStreamSummary(fixture.store, 'test', `member-${member}`, kind, Infinity, take);
  }
  reads.clear();
  expect(await readStreamSummary(fixture.store, 'test', 'member-alice', kind, Infinity, take))
    .toEqual({ ids: ['alice'], sequence: 1 });
  expect(reads.calls).toEqual([{ subject: 'member-alice', fromSequence: 2, rows: 0 }]);
  reads.clear();
  expect(await readStreamSummary(fixture.store, 'test', 'member-bob', kind, Infinity, take))
    .toEqual({ ids: ['bob'], sequence: 2 });
  expect(reads.calls).toEqual([{ subject: 'member-bob', fromSequence: 1, rows: 1 }]);
}
it('drops the least recently used subject and rebuilds it from the first event',
  dropsLeastRecentlyUsed);

async function rejectsWrongSiloWithoutAddingIt() {
  fixture = await natsFixture();
  await fixture.seed([event('valid'), { ...event('wrong'), silo: 'other' }]);
  const snapshots: ReturnType<typeof take>[] = [];
  function inspect(summary: ReturnType<typeof empty>, sequence: number) {
    const copy = take(summary, sequence);
    snapshots.push(copy);
    return copy;
  }
  await expect(readStreamSummary(fixture.store, 'test', 'member-alice', kind, Infinity, inspect))
    .rejects.toBeInstanceOf(WrongSiloError);
  expect(snapshots).toEqual([]);
  const reads = countReads(fixture.store);
  await expect(readStreamSummary(fixture.store, 'test', 'member-alice', kind, Infinity, inspect))
    .rejects.toBeInstanceOf(WrongSiloError);
  expect(reads.calls).toEqual([{ subject: 'member-alice', fromSequence: 2, rows: 1 }]);
  expect(snapshots).toEqual([]);
}
it('rejects a wrong-silo row without adding it or returning partial facts',
  rejectsWrongSiloWithoutAddingIt);

async function continuesAfterCallerTimeout(fail: boolean) {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const completed = Promise.withResolvers<void>();
  const fromPositions: number[] = [];
  const deadlines: number[] = [];
  let firstRead = true;
  async function* readStream(_subject: string, from = 1, deadline = Infinity) {
    fromPositions.push(from);
    deadlines.push(deadline);
    if (firstRead) {
      firstRead = false;
      yield { sequence: 1, event: event('first') };
      entered.resolve();
      await release.promise;
      completed.resolve();
      if (fail) throw new Error('read failed');
      yield { sequence: 2, event: event('second') };
    } else if (from === 2) {
      yield { sequence: 2, event: event('second') };
    }
  }
  const store = { readStream };
  const snapshots: ReturnType<typeof take>[] = [];
  function inspect(summary: ReturnType<typeof empty>, sequence: number) {
    const copy = take(summary, sequence);
    snapshots.push(copy);
    return copy;
  }
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const started = performance.now();
  const pending = readStreamSummary(store, 'test', 'member-alice', kind,
    started + 500, inspect);
  await entered.promise;
  expect(deadlines[0]).toBeGreaterThanOrEqual(started + 10_000);
  const rejection = expect(pending).rejects.toBeInstanceOf(TimeoutError);
  await vi.advanceTimersByTimeAsync(1000);
  await rejection;
  expect(snapshots).toEqual([]);
  release.resolve();
  await completed.promise;
  const next = await readStreamSummary(store, 'test', 'member-alice', kind, Infinity, inspect);
  expect(next).toEqual({ ids: ['first', 'second'], sequence: 2 });
  if (fail) {
    expect(fromPositions).toEqual([1, 2]);
    expect(snapshots).toHaveLength(1);
  } else {
    expect(fromPositions).toEqual([1, 3]);
  }
}
it.each([false, true])('keeps progress after caller timeout and frees the queue (read fails: %s)',
  continuesAfterCallerTimeout);

async function keepsStoresKindsAndSilosApart() {
  fixture = await natsFixture();
  await fixture.seed([event('first')]);
  await readStreamSummary(fixture.store, 'test', 'member-alice', kind, Infinity, take);
  const reads = countReads(fixture.reader);
  expect(await readStreamSummary(fixture.reader, 'test', 'member-alice', kind, Infinity, take))
    .toEqual({ ids: ['first'], sequence: 1 });
  expect(reads.calls[0]?.fromSequence).toBe(1);
  const anotherKind = { ...kind, name: 'another' };
  const writerReads = countReads(fixture.store);
  await readStreamSummary(fixture.store, 'test', 'member-alice', anotherKind, Infinity, take);
  expect(writerReads.calls[0]?.fromSequence).toBe(1);
  await expect(readStreamSummary(fixture.store, 'other', 'member-alice', kind, Infinity, take))
    .rejects.toBeInstanceOf(WrongSiloError);
}
it('keeps store instances, kind names and silos apart', keepsStoresKindsAndSilosApart);

async function retriesRowRejectedByFold() {
  fixture = await natsFixture();
  await fixture.seed([event('first'), event('second')]);
  let rejectSecond = true;
  function checkedAdd(summary: ReturnType<typeof empty>, row: StoredEvent) {
    if (rejectSecond && row.event.id === 'second') throw new Error('Invalid row');
    add(summary, row);
  }
  const checkedKind = { ...kind, name: 'checked', add: checkedAdd };
  let takes = 0;
  function inspect(summary: ReturnType<typeof empty>, sequence: number) {
    takes++;
    return take(summary, sequence);
  }
  await expect(readStreamSummary(
    fixture.store, 'test', 'member-alice', checkedKind, Infinity, inspect))
    .rejects.toThrow('Invalid row');
  expect(takes).toBe(0);
  rejectSecond = false;
  const reads = countReads(fixture.store);
  expect(await readStreamSummary(
    fixture.store, 'test', 'member-alice', checkedKind, Infinity, inspect))
    .toEqual({ ids: ['first', 'second'], sequence: 2 });
  expect(reads.calls).toEqual([{ subject: 'member-alice', fromSequence: 2, rows: 1 }]);
}
it('retries a row rejected by add without changing its position or returning partial facts',
  retriesRowRejectedByFold);

function size(summary: ReturnType<typeof empty>) {
  return summary.ids.length;
}
const boundedKind = { ...kind, name: 'bounded-ids', keep: 10,
  budget: { limit: 3, size } };

async function boundsRetainedFactsAsStreamsGrow() {
  fixture = await natsFixture();
  await fixture.seed([event('alice-1'), event('alice-2'), event('bob', 'member-bob')]);
  await readStreamSummary(fixture.store, 'test', 'member-alice', boundedKind, Infinity, take);
  await readStreamSummary(fixture.store, 'test', 'member-bob', boundedKind, Infinity, take);
  await fixture.seed([event('alice-3')]);
  const reads = countReads(fixture.store);
  const grown = await readStreamSummary(
    fixture.store, 'test', 'member-alice', boundedKind, Infinity, take);
  expect(grown.ids).toEqual(['alice-1', 'alice-2', 'alice-3']);
  reads.clear();
  await readStreamSummary(fixture.store, 'test', 'member-bob', boundedKind, Infinity, take);
  expect(reads.calls).toEqual([{ subject: 'member-bob', fromSequence: 1, rows: 1 }]);
}
it('drops the least recently used summary when retained facts exceed the budget',
  boundsRetainedFactsAsStreamsGrow);

async function rebuildsAnOversizedStreamWithoutForgettingFacts() {
  fixture = await natsFixture();
  await fixture.seed([event('one'), event('two'), event('three'), event('four')]);
  const expected = { ids: ['one', 'two', 'three', 'four'], sequence: 4 };
  expect(await readStreamSummary(
    fixture.store, 'test', 'member-alice', boundedKind, Infinity, take)).toEqual(expected);
  const reads = countReads(fixture.store);
  expect(await readStreamSummary(
    fixture.store, 'test', 'member-alice', boundedKind, Infinity, take)).toEqual(expected);
  expect(reads.calls).toEqual([{ subject: 'member-alice', fromSequence: 1, rows: 4 }]);
}
it('rebuilds an oversized summary rather than dropping facts used to refuse access',
  rebuildsAnOversizedStreamWithoutForgettingFacts);

async function boundsProgressAfterFailedRead() {
  fixture = await natsFixture();
  await fixture.seed([event('one'), event('bob', 'member-bob')]);
  const checkedBudget = { ...boundedKind, name: 'failed-budget', add: rejectInvalid };
  function rejectInvalid(summary: ReturnType<typeof empty>, row: StoredEvent) {
    if (row.event.id === 'invalid') throw new Error('Invalid row');
    add(summary, row);
  }
  await readStreamSummary(fixture.store, 'test', 'member-alice', checkedBudget, Infinity, take);
  await readStreamSummary(fixture.store, 'test', 'member-bob', checkedBudget, Infinity, take);
  await fixture.seed([event('two'), event('three'), event('invalid')]);
  await expect(readStreamSummary(
    fixture.store, 'test', 'member-alice', checkedBudget, Infinity, take))
    .rejects.toThrow('Invalid row');
  const reads = countReads(fixture.store);
  expect(await readStreamSummary(
    fixture.store, 'test', 'member-bob', checkedBudget, Infinity, take))
    .toEqual({ ids: ['bob'], sequence: 2 });
  expect(reads.calls).toEqual([{ subject: 'member-bob', fromSequence: 1, rows: 1 }]);
}
it('counts retained progress from failed reads towards the budget', boundsProgressAfterFailedRead);
