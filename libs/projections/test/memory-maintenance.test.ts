import { expect, it } from 'vitest';
import { memoryMaintenanceRecordedDataSchema } from '@opencrane/events';
import { selectMaintenanceInputs, type MaintenanceFact } from '../src/memory-maintenance.ts';

function fact(memoryId: string, position: number, encryptedBytes = 4124): MaintenanceFact {
  return { memoryId, revision: 1, expiresAt: null, pinned: false, position,
    status: 'available', encryptedBytes };
}

function reviewed(input: MaintenanceFact, selectedAt: string) {
  const date = selectedAt.slice(0, 10);
  return memoryMaintenanceRecordedDataSchema.parse({
    scopeId: 'a'.repeat(64), nightId: 'b'.repeat(64), batchKey: 'c'.repeat(64),
    inputRevision: 'd'.repeat(64), date, bindingRevision: 1, memberId: 'alice',
    acceptedCapCents: 100, intendedAt: `${date}T02:00:00.000Z`, selectedAt,
    action: 'no_changes', reason: null, reviewedPosition: input.position,
    inputRefs: [{ memoryId: input.memoryId, revision: input.revision,
      expiresAt: input.expiresAt, position: input.position }],
  });
}

function wholeEscapedFacts() {
  const first = fact('first', 1);
  const second = fact('second', 2);
  const selection = selectMaintenanceInputs([second, first], [], 2, 0,
    '2026-10-12T02:00:00.000Z');
  expect(selection.inputRefs).toMatchObject([{ memoryId: 'first' }]);
  expect(selection.waitingCount).toBe(2);
  const oversized = fact('oversized', 1, 9000);
  const small = fact('small', 2, 29);
  const stopped = selectMaintenanceInputs([oversized, small], [], 2, 0,
    '2026-10-12T02:00:00.000Z');
  expect(stopped.inputRefs).toEqual([]);
  expect(stopped.dirty).toBe(true);
}
it('fits a 4096-byte fact and stops before a whole fact that exceeds 16 KiB', wholeEscapedFacts);

function expiryAndPins() {
  const expired = { ...fact('expired', 1, 9000),
    expiresAt: '2026-10-13T00:00:00.000Z' };
  const pinned = { ...fact('pinned', 2), pinned: true,
    expiresAt: '2026-10-13T00:00:00.000Z' };
  const before = reviewed(expired, '2026-10-12T02:00:00.000Z');
  const due = selectMaintenanceInputs([expired, pinned], [before], 2, 0,
    '2026-10-13T02:00:00.000Z');
  expect(due.inputRefs).toMatchObject([{ memoryId: 'expired' }]);
  const after = reviewed(expired, '2026-10-13T02:00:00.000Z');
  const clean = selectMaintenanceInputs([expired, pinned], [before, after], 2, 0,
    '2026-10-14T02:00:00.000Z');
  expect(clean.dirty).toBe(false);
  const freshPin = { ...fact('fresh-pin', 3), pinned: true,
    expiresAt: '2026-10-20T00:00:00.000Z' };
  const protectedInput = selectMaintenanceInputs([freshPin], [], 3, 0,
    '2026-10-13T02:00:00.000Z');
  expect(protectedInput.inputRefs).toMatchObject([{ memoryId: 'fresh-pin' }]);
}
it('makes a reviewed expiry due once and excludes due pins', expiryAndPins);

function reviewedRevisions() {
  const first = fact('first', 1, 29);
  const changed = { ...first, revision: 2, position: 3 };
  const second = fact('second', 2, 29);
  const saved = reviewed(first, '2026-10-12T02:00:00.000Z');
  const selection = selectMaintenanceInputs([changed, second], [saved], 3, 0,
    '2026-10-13T02:00:00.000Z');
  expect(selection.inputRefs).toMatchObject([
    { memoryId: 'second', revision: 1 }, { memoryId: 'first', revision: 2 },
  ]);
}
it('keeps omitted and newer revisions dirty after a saved review', reviewedRevisions);

function expiryDuringSelection() {
  const input = { ...fact('expires-during-selection', 1, 29),
    expiresAt: '2026-10-12T02:05:00.000Z' };
  const lateSelection = reviewed(input, '2026-10-12T02:10:00.000Z');
  const nextNight = selectMaintenanceInputs([input], [lateSelection], 1, 0,
    '2026-10-13T02:00:00.000Z');
  expect(nextNight.dirty).toBe(true);
  expect(nextNight.inputRefs).toEqual([{ memoryId: 'expires-during-selection', revision: 1,
    expiresAt: '2026-10-12T02:05:00.000Z', position: 1 }]);
  const expiryReview = reviewed(input, '2026-10-13T02:10:00.000Z');
  const afterReview = selectMaintenanceInputs([input], [lateSelection, expiryReview], 1, 0,
    '2026-10-14T02:00:00.000Z');
  expect(afterReview.dirty).toBe(false);
  expect(afterReview.inputRefs).toEqual([]);
}
it('keeps expiry due when it falls between the intended boundary and selection', expiryDuringSelection);
