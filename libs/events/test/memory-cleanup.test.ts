import { expect, it } from 'vitest';
import { parseEventByType } from '../src/index.ts';

const scopeId = 'a'.repeat(64);
const completion = {
  id: 'cleanup-root', commandId: 'cleanup-root', type: 'memory.cleanup_recorded',
  source: 'opencrane-worker', subject: `scope-${scopeId}`, silo: 'acme',
  time: '2026-10-12T00:00:00Z', principal: { kind: 'system', id: 'opencrane-worker' },
  correlation: {}, data: { schemaVersion: 1, scopeId, scopeKind: 'person', ownerId: 'alice',
    changeId: 'forget-root', outcome: 'completed' },
};

it('accepts a cleanup completion without private text or keys', function accepted() {
  expect(parseEventByType(completion).success).toBe(true);
});

const invalid = [
  { ...completion, subject: 'scope-other' },
  { ...completion, principal: { kind: 'human', id: 'alice' } },
  { ...completion, source: 'opencrane-server' },
  { ...completion, data: { ...completion.data, outcome: 'unavailable' } },
  { ...completion, data: { ...completion.data, text: 'Private text' } },
  { ...completion, data: { ...completion.data, keyId: `key:${scopeId}` } },
];
it.each(invalid)('refuses invalid cleanup evidence %j', function refused(input) {
  expect(parseEventByType(input).success).toBe(false);
});
