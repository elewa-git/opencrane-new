import { expect, it } from 'vitest';
import { parseEventByType } from '../src/index.ts';

const forgotten = {
  id: 'forget-root', commandId: 'forget-root', type: 'memory.forgotten',
  source: 'opencrane-server', subject: `scope-${'a'.repeat(64)}`, silo: 'acme',
  time: '2026-10-11T00:00:00Z', principal: { kind: 'human', id: 'alice' }, correlation: {},
  data: { schemaVersion: 1, scopeId: 'a'.repeat(64), scopeKind: 'person', ownerId: 'alice',
    memoryId: 'root', expectedRevision: 1, revision: 2 },
};

it('accepts a payload-free tombstone with an exact next revision', function accepted() {
  expect(parseEventByType(forgotten).success).toBe(true);
});

const invalidData = [
  { ...forgotten.data, revision: 1 },
  { ...forgotten.data, expectedRevision: Number.MAX_SAFE_INTEGER, revision: Number.MAX_SAFE_INTEGER },
  { ...forgotten.data, text: 'Private text' },
  { ...forgotten.data, ciphertext: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' },
];
it.each(invalidData)('refuses an invalid tombstone %j', function refused(data) {
  expect(parseEventByType({ ...forgotten, data }).success).toBe(false);
});

it('refuses a tombstone on another scope stream', function wrongStream() {
  const input = { ...forgotten, subject: 'scope-other' };
  expect(parseEventByType(input).success).toBe(false);
});

it('preserves the exact legacy shape for replay without inventing a revision', function legacy() {
  const data = { scopeId: 'old-scope', memoryId: 'old-fact' };
  const input = { ...forgotten, data, subject: 'scope-old-scope' };
  expect(parseEventByType(input).success).toBe(true);
});
