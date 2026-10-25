import assert from 'node:assert/strict';

export interface Receipt {
  id: string;
  commandId: string;
  subject: string;
  sequence: number;
}

export function checkSurvival(retained: Receipt[], acknowledged: Receipt[],
  subjectPositions: Record<string, number>, unresolved: string[]) {
  const byId = new Map<string, Receipt>();
  const commandIds = new Set<string>();
  const positions: Record<string, number> = {};
  let previous = 0;
  for (const row of retained) {
    assert.equal(row.sequence, previous + 1, 'Retained order or position changed');
    assert.equal(byId.has(row.id), false, 'Repeated event');
    // Keep one command from appearing twice even if its event id changes.
    const command = JSON.stringify([row.subject, row.commandId]);
    assert.equal(commandIds.has(command), false, 'Repeated command');
    commandIds.add(command);
    byId.set(row.id, row);
    positions[row.subject] = row.sequence;
    previous = row.sequence;
  }
  assert.deepEqual(positions, subjectPositions, 'Subject positions changed');
  const acknowledgedIds = new Set<string>();
  for (const receipt of acknowledged) {
    assert.equal(acknowledgedIds.has(receipt.id), false, 'Repeated acknowledgement');
    assert.equal(unresolved.includes(receipt.id), false, 'Unresolved acknowledgement');
    assert.deepEqual(byId.get(receipt.id), receipt, 'Acknowledged event changed or missing');
    acknowledgedIds.add(receipt.id);
  }
  const observedUnresolved: string[] = [];
  for (const id of unresolved) {
    if (byId.has(id)) {
      observedUnresolved.push(id);
    }
  }
  // Report observations without treating an unseen timeout as safe to repeat with a new id.
  return { acknowledged: acknowledged.length, unresolved: [...unresolved], observedUnresolved };
}
