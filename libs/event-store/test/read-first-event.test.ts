import { afterEach, expect, it } from 'vitest';
import { FirstEventRefused, readFirstEvent, type FirstEventRead } from '../src/index.ts';
import { countReads, event, natsFixture } from './testing.ts';

let fixture: Awaited<ReturnType<typeof natsFixture>>;

async function close() {
  await fixture?.close();
}
afterEach(close);

async function readsCreationAtSavedPosition() {
  fixture = await natsFixture();
  await fixture.seed([event('gap', 'member-bob'), event('creation'), event('later')]);
  const counts = countReads(fixture.store);
  const request = { silo: 'test', subject: 'member-alice', type: 'member.joined',
    deadline: Infinity, position: 2 };
  const first = await readFirstEvent(fixture.store, request);
  expect(first).toMatchObject({ sequence: 2, event: { id: 'creation' } });
  const withoutIndex: FirstEventRead = { ...request };
  delete withoutIndex.position;
  expect(await readFirstEvent(fixture.store, withoutIndex)).toEqual(first);
  expect(counts.calls).toEqual([
    { subject: 'member-alice', fromSequence: 1, rows: 1 },
    { subject: 'member-alice', fromSequence: 2, rows: 1 },
  ]);
}
it('shares the saved creation position with callers that have no index', readsCreationAtSavedPosition);

async function discoversOnlyFirstRow() {
  fixture = await natsFixture();
  await fixture.seed([event('gap', 'member-bob'), event('creation'), event('later')]);
  const counts = countReads(fixture.store);
  const request = { silo: 'test', subject: 'member-alice', type: 'member.joined',
    deadline: Infinity };
  expect(await readFirstEvent(fixture.store, request))
    .toMatchObject({ sequence: 2, event: { id: 'creation' } });
  expect(await readFirstEvent(fixture.store, request))
    .toMatchObject({ sequence: 2, event: { id: 'creation' } });
  expect(counts.calls).toEqual([
    { subject: 'member-alice', fromSequence: 1, rows: 1 },
    { subject: 'member-alice', fromSequence: 2, rows: 1 },
  ]);
}
it('discovers one creation event and never reads later messages', discoversOnlyFirstRow);

async function refusesWrongCreation() {
  fixture = await natsFixture();
  await fixture.seed([event('gap', 'member-bob'), event('creation'), event('later')]);
  const request = { silo: 'test', subject: 'member-alice', type: 'member.joined',
    deadline: Infinity, position: 3 };
  await expect(readFirstEvent(fixture.store, request)).rejects.toBeInstanceOf(FirstEventRefused);
  const wrongSilo = { ...request, silo: 'other', position: 2 };
  await expect(readFirstEvent(fixture.store, wrongSilo)).rejects.toBeInstanceOf(FirstEventRefused);
  const wrongType = { ...request, type: 'assistant.created', position: 2 };
  await expect(readFirstEvent(fixture.store, wrongType)).rejects.toBeInstanceOf(FirstEventRefused);
  const valid = { ...request, position: 2 };
  expect(await readFirstEvent(fixture.store, valid)).toMatchObject({ sequence: 2 });
}
it('refuses a mismatched position, silo or creation type without keeping it', refusesWrongCreation);
