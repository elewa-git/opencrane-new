import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkPersonalMemory, type MemoryEvidence } from './memory-personal-evidence.ts';

function evidence(): MemoryEvidence {
  const saved = { outcome: 'saved', changeId: 'write', scopeId: 'person', memoryId: 'fact',
    revision: 1, savedAt: '2026-10-25T00:00:00Z' };
  const corrected = { ...saved, outcome: 'accepted', operation: 'correct', changeId: 'edit',
    revision: 2, acceptedAt: saved.savedAt, cleanupStatus: 'completed' };
  const forgotten = { ...corrected, operation: 'forget', changeId: 'forget', revision: 3,
    hidden: true, cleanupStatus: 'forgotten', forgottenAt: saved.savedAt };
  return {
    receipts: [saved, corrected, forgotten],
    originals: [saved, corrected, forgotten],
    recovery: ['POST', 'GET'],
    snapshots: [
      { stage: 'reload', forgotten: { status: 'unavailable', reason: 'forgotten' },
        facts: [{ memoryId: 'survivor', revision: 2, text: 'Current synthetic value' }] },
      { stage: 'restart', forgotten: { status: 'unavailable', reason: 'forgotten' },
        facts: [{ memoryId: 'survivor', revision: 2, text: 'Current synthetic value' }] },
      { stage: 'replay', forgotten: { status: 'unavailable', reason: 'forgotten' },
        facts: [{ memoryId: 'survivor', revision: 2, text: 'Current synthetic value' }] },
    ],
    survivor: { memoryId: 'survivor', revision: 2, text: 'Current synthetic value' },
    forgottenText: 'Discarded synthetic value',
    replay: { eventsBefore: 12, eventsAfter: 12, callsBefore: 0, callsAfter: 0 },
  };
}

function acceptsCompleteProof() {
  checkPersonalMemory(evidence());
}
test('accepts complete personal HTTP evidence', acceptsCompleteProof);

function refusesMissingSavedReceipt() {
  const proof = evidence();
  proof.receipts.shift();
  assert.throws(() => checkPersonalMemory(proof));
}
test('refuses a missing saved receipt', refusesMissingSavedReceipt);

function refusesStaleRevision() {
  const proof = evidence();
  proof.snapshots[2]!.facts[0]!.revision = 1;
  assert.throws(() => checkPersonalMemory(proof));
}
test('refuses a stale corrected revision after replay', refusesStaleRevision);

function refusesForgottenText() {
  for (const snapshotIndex of [0, 1, 2]) {
    const proof = evidence();
    proof.snapshots[snapshotIndex]!.facts.push({ memoryId: 'fact', revision: 2,
      text: proof.forgottenText });
    assert.throws(() => checkPersonalMemory(proof));
  }
}
test('refuses forgotten text after reload, restart or replay', refusesForgottenText);

function refusesResend() {
  const proof = evidence();
  proof.recovery.push('POST');
  assert.throws(() => checkPersonalMemory(proof));
}
test('refuses a repeated POST during Check status', refusesResend);

function refusesReplayEffects() {
  for (const field of ['eventsAfter', 'callsAfter'] as const) {
    const proof = evidence();
    proof.replay[field] += 1;
    assert.throws(() => checkPersonalMemory(proof));
  }
}
test('refuses replay event or model effects', refusesReplayEffects);

function refusesChangedOriginal() {
  const proof = evidence();
  proof.originals[1] = { ...proof.originals[1]!, changeId: 'another-edit' };
  assert.throws(() => checkPersonalMemory(proof));
}
test('refuses an unrelated original receipt', refusesChangedOriginal);
