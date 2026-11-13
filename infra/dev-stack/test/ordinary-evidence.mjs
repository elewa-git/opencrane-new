import assert from 'node:assert/strict';

export function checkOrdinaryCosts(records) {
  assert.equal(records.length, 2, JSON.stringify(records));
  function missingCost(record) {
    return record.outcome === 'responded' && record.costStatus === 'not_reported'
      && record.costCents === undefined;
  }
  assert(records.every(missingCost));
}
