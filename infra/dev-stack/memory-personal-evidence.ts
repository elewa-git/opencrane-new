import assert from 'node:assert/strict';

type Receipt = Record<string, unknown>;
type Fact = { memoryId: string; revision: number; text: string };
export type MemoryEvidence = {
  receipts: Receipt[];
  originals: Receipt[];
  recovery: string[];
  snapshots: Array<{ stage: string; forgotten: Receipt; facts: Fact[] }>;
  survivor: Fact;
  forgottenText: string;
  replay: { eventsBefore: number; eventsAfter: number; callsBefore: number; callsAfter: number };
};

export function checkPersonalMemory(proof: MemoryEvidence) {
  assert.equal(proof.receipts.length, 3, 'Store, correction and forget need receipts');
  assert.equal(proof.originals.length, 3, 'Original commands need status receipts');
  const [saved, corrected, forgotten] = proof.receipts;
  assert(saved && corrected && forgotten);
  assert.equal(saved['outcome'], 'saved');
  assert.equal(saved['revision'], 1);
  assert.equal(corrected['operation'], 'correct');
  assert.equal(corrected['outcome'], 'accepted');
  assert.equal(corrected['revision'], 2);
  assert.equal(forgotten['operation'], 'forget');
  assert.equal(forgotten['outcome'], 'accepted');
  assert.equal(forgotten['revision'], 3);
  assert.equal(forgotten['hidden'], true);
  for (const [index, receipt] of proof.receipts.entries()) {
    for (const field of ['changeId', 'scopeId', 'memoryId', 'revision']) {
      assert(receipt[field], 'Receipt identity is required');
      assert.equal(proof.originals[index]![field], receipt[field], 'Original receipt changed');
    }
    assert.equal(receipt['scopeId'], saved['scopeId']);
    assert.equal(receipt['memoryId'], saved['memoryId']);
    assert.equal(typeof (receipt['acceptedAt'] ?? receipt['savedAt']), 'string');
    assert(!('text' in receipt), 'Receipts must exclude fact text');
  }
  for (const [index, receipt] of proof.originals.entries()) {
    const accepted = proof.receipts[index]!;
    for (const field of ['outcome', 'operation', 'savedAt', 'acceptedAt']) {
      assert.equal(receipt[field], accepted[field], 'Original outcome changed');
    }
    assert(!('text' in receipt), 'Status receipts must exclude fact text');
  }
  assert.equal(proof.originals[1]!['cleanupStatus'], 'completed');
  assert.equal(proof.originals[2]!['cleanupStatus'], 'forgotten');
  assert.equal(typeof proof.originals[2]!['forgottenAt'], 'string');
  assert.deepEqual(proof.recovery, ['POST', 'GET'], 'Recovery must read without resending');
  assert.deepEqual(proof.snapshots.map(snapshotStage), ['reload', 'restart', 'replay']);
  for (const snapshot of proof.snapshots) {
    assert.equal(snapshot.forgotten['reason'], 'forgotten');
    assert(!JSON.stringify(snapshot).includes(proof.forgottenText));
    assert.equal(snapshot.facts.length, 1);
    assert.deepEqual(snapshot.facts[0], proof.survivor, 'Corrected value must survive');
  }
  assert.equal(proof.survivor.revision, 2);
  for (const count of Object.values(proof.replay)) {
    assert(Number.isSafeInteger(count) && count >= 0, 'Replay counts must be observed');
  }
  assert.equal(proof.replay.eventsAfter, proof.replay.eventsBefore, 'Replay appended events');
  assert.equal(proof.replay.callsBefore, 0, 'Human operations need no model calls');
  assert.equal(proof.replay.callsAfter, 0, 'Replay called a model');
}

function snapshotStage(snapshot: MemoryEvidence['snapshots'][number]) {
  return snapshot.stage;
}
