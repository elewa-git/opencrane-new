import assert from 'node:assert/strict';

export interface Delivery {
  type: 'member' | 'ready' | 'resync' | 'refused';
  position: number;
  generation: number;
  memberId?: string;
}
export interface Replica { pid: number; port: number }

export function checkReplicas(first: Replica, second: Replica): void {
  assert.ok(first.pid > 0 && second.pid > 0, 'Missing process identity');
  assert.notEqual(first.pid, second.pid, 'Repeated process');
  assert.notEqual(first.port, second.port, 'Repeated port');
}
export function checkDelivery(actual: Delivery[], expected: Delivery[]): void {
  const records = actual.filter(isMember);
  assert.deepEqual(records, expected, 'Delivery differs from saved changes');
}
function isMember(delivery: Delivery) {
  return delivery.type === 'member';
}

export function checkClosure(messages: Delivery[], code: number,
  expectedCode: number, terminal?: 'refused' | 'resync'): void {
  assert.equal(code, expectedCode, 'Unexpected close outcome');
  // Inspect the whole refused attempt, including anything before its terminal reply.
  assert.equal(messages.length, terminal === undefined ? 0 : 1, 'Unexpected delivery');
  if (terminal !== undefined) {
    assert.equal(messages[0]?.type, terminal, 'Missing terminal reply');
  }
}
