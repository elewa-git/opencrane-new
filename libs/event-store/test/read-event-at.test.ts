import { afterEach, expect, it } from 'vitest';
import { readEventAt } from '../src/index.ts';
import { countReads, event, natsFixture } from './testing.ts';

let fixture: Awaited<ReturnType<typeof natsFixture>>;
async function close() {
  await fixture?.close();
}
afterEach(close);

async function readsOnlyTheExactPosition() {
  fixture = await natsFixture();
  await fixture.seed([event('first'), event('gap', 'member-bob'), event('last')]);
  const reads = countReads(fixture.store);
  const deadline = Infinity;
  expect(await readEventAt(fixture.store, 'member-alice', 1, deadline))
    .toMatchObject({ sequence: 1, event: { id: 'first' } });
  expect(reads.calls).toEqual([{ subject: 'member-alice', fromSequence: 1, rows: 1 }]);
  expect(await readEventAt(fixture.store, 'member-alice', 2, deadline)).toBeUndefined();
  expect(reads.calls[1]).toEqual({ subject: 'member-alice', fromSequence: 2, rows: 1 });
  expect(await readEventAt(fixture.store, 'member-alice', 3, deadline))
    .toMatchObject({ sequence: 3, event: { id: 'last' } });
  expect(await readEventAt(fixture.store, 'member-alice', 4, deadline)).toBeUndefined();
  expect(reads.calls[3]).toEqual({ subject: 'member-alice', fromSequence: 4, rows: 0 });
  await expect(readEventAt(fixture.store, 'member-alice', 1, performance.now() - 1))
    .rejects.toThrow();
}
it('returns only the requested event and keeps the caller deadline', readsOnlyTheExactPosition);
