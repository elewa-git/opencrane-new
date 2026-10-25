import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { checkUpgradeRecovery, type RecoveryState } from './upgrade-recovery-check.ts';

const before: RecoveryState = {
  events: [{ sequence: 1, subject: 'ev.member.alice', id: 'joined', eventDigest: 'd'.repeat(64) },
    { sequence: 2, subject: 'ev.member.bob', id: 'other', eventDigest: 'e'.repeat(64) },
    { sequence: 3, subject: 'ev.member.alice', id: 'role', eventDigest: 'f'.repeat(64) }],
  checkpoint: 3, rowsDigest: 'a'.repeat(64),
};
const hash = createHash('sha256');
for (const row of before.events) {
  hash.update(JSON.stringify([row.sequence, row.subject, row.id]) + '\n');
}
const descriptor = {
  version: 1, kind: 'event-bytes-only', silo: 'test', attempt: 'before-upgrade',
  created: '2026-10-25T00:00:00Z',
  config: { name: 'EVENTS', subjects: ['ev.>'], storage: 'file', retention: 'limits',
    num_replicas: 1, discard: 'old' },
  firstSequence: 1, lastSequence: 3, eventCount: 3,
  subjectPositions: { 'ev.member.alice': 3, 'ev.member.bob': 2 },
  identityDigest: hash.digest('hex'), byteCount: 100, sha256: 'b'.repeat(64),
};

function acceptsCompleteProof() {
  expect(checkUpgradeRecovery(before, structuredClone(before), descriptor)).toBeUndefined();
}
it('accepts the complete event and projection comparison', acceptsCompleteProof);

const faults = ['omitted', 'reordered', 'duplicated', 'position', 'ahead', 'incomplete',
  'rows', 'behind', 'changed-id', 'changed-subject', 'duplicate-before', 'changed-event'] as const;
function refusesBrokenProof(fault: typeof faults[number]) {
  const expected = structuredClone(before);
  const actual = structuredClone(before);
  const archive = structuredClone(descriptor);
  if (fault === 'omitted') actual.events.splice(1, 1);
  if (fault === 'reordered') actual.events.reverse();
  if (fault === 'duplicated') actual.events[1] = { ...actual.events[0]! };
  if (fault === 'position') archive.subjectPositions['ev.member.bob'] = 3;
  if (fault === 'ahead') actual.checkpoint = 4;
  if (fault === 'incomplete') archive.byteCount = 0;
  if (fault === 'rows') actual.rowsDigest = 'c'.repeat(64);
  if (fault === 'behind') actual.checkpoint = 2;
  if (fault === 'changed-id') actual.events[0]!.id = 'replacement';
  if (fault === 'changed-subject') actual.events[0]!.subject = 'ev.member.other';
  if (fault === 'changed-event') actual.events[0]!.eventDigest = '0'.repeat(64);
  if (fault === 'duplicate-before') {
    expected.events[1]!.id = expected.events[0]!.id;
    actual.events = structuredClone(expected.events);
  }
  function check() {
    checkUpgradeRecovery(expected, actual, archive);
  }
  expect(check).toThrow('Upgrade recovery comparison refused');
}
it.each(faults)('refuses %s evidence', refusesBrokenProof);
