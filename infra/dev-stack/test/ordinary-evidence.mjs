import assert from 'node:assert/strict';

export function checkOrdinaryCosts(records) {
  const read = remoteReply('read_fixture_quote');
  const write = remoteReply('change_delivery_slot');
  // The gateway also records receiving the local refusal, without a remote start or cost.
  const refusalReceipt = { toolName: 'read_fixture_quote', outcome: 'responded',
    evidence: 'response_received', costStatus: undefined, costCents: undefined, remote: false };
  const expected = [read, write, refusalReceipt];
  assert.deepEqual(records, expected);
}

function remoteReply(toolName) {
  return { toolName, outcome: 'responded', evidence: 'adapter_response_received',
    costStatus: 'not_reported', costCents: undefined, remote: true };
}
