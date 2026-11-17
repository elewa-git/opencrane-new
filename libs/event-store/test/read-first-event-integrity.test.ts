import { expect, it } from 'vitest';
import { readFirstEvent, type FirstEventRead, type StoredEvent } from '../src/index.ts';
import { event } from './testing.ts';

const request: FirstEventRead = { silo: 'test', subject: 'member-alice', type: 'member.joined',
  deadline: Infinity, position: 2 };
const creation: StoredEvent = { sequence: 2, event: event('creation') };

function source(rows: StoredEvent[]) {
  async function* readStream() {
    for (const row of rows) yield row;
  }
  return { readStream };
}

async function refusesMalformedCreation(kind: string) {
  let row = structuredClone(creation);
  if (kind === 'subject') row.event.subject = 'member-bob';
  if (kind === 'silo') row.event.silo = 'other';
  if (kind === 'type') row.event.type = 'member.removed';
  if (kind === 'position') row.sequence = 1;
  let rows = [row];
  if (kind === 'missing') rows = [];
  if (kind === 'duplicate') rows = [row, row];
  const store = source(rows);
  await expect(readFirstEvent(store, request)).rejects.toThrow('Creation history unavailable');
}
it.each(['subject', 'silo', 'type', 'position', 'missing', 'duplicate'])(
  'refuses an isolated %s creation fault', refusesMalformedCreation);

async function refusesChangedCachedId() {
  const rows = [structuredClone(creation)];
  const store = source(rows);
  expect(await readFirstEvent(store, request)).toEqual(creation);
  rows[0]!.event.id = 'replacement';
  await expect(readFirstEvent(store, request)).rejects.toThrow('Creation history unavailable');
}
it('refuses an isolated changed cached creation id', refusesChangedCachedId);
