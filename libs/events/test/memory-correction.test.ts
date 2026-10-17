import { expect, it } from 'vitest';
import { parseEventByType } from '../src/index.ts';
import { memoryWrittenExample } from '../src/memory.ts';

const correction = { id: 'correction', commandId: 'correction', type: 'memory.corrected',
  source: 'opencrane-server', subject: `scope-${memoryWrittenExample.scopeId}`, silo: 'test',
  time: '2026-10-17T00:00:00Z', principal: { kind: 'human', id: 'alice' }, correlation: {},
  data: { ...memoryWrittenExample, expectedRevision: 3, revision: 4,
    supersedes: { memoryId: memoryWrittenExample.memoryId, revision: 3 }, reason: 'human' } };

it('accepts a complete correction and retains the explicit legacy parser', function supported() {
  expect(parseEventByType(correction).success).toBe(true);
  const data = { scopeId: 'old-scope', memoryId: 'old-fact',
    ciphertext: 'ZmFrZS1jaXBoZXJ0ZXh0', keyId: 'key:old' };
  expect(parseEventByType({ ...correction, data }).success).toBe(true);
});

const invalid = [
  { expectedRevision: 2 }, { revision: Number.MAX_SAFE_INTEGER + 1 },
  { supersedes: { memoryId: 'other', revision: 3 } },
  { supersedes: { memoryId: memoryWrittenExample.memoryId, revision: 2 } },
  { scopeKind: 'group', kind: 'preference' }, { text: 'private replacement' },
  { reason: 'free text' }, { expiresAt: '2026-01-01T00:00:00Z' },
  { dependsOn: [{ scopeId: memoryWrittenExample.scopeId,
    memoryId: memoryWrittenExample.memoryId, revision: 3 }] },
];
it.each(invalid)('refuses invalid correction metadata %j', function refused(patch) {
  const input = { ...correction, data: { ...correction.data, ...patch } };
  expect(parseEventByType(input).success).toBe(false);
});

it('binds the replacement to its scope subject', function wrongSubject() {
  expect(parseEventByType({ ...correction, subject: 'scope-other' }).success).toBe(false);
});
