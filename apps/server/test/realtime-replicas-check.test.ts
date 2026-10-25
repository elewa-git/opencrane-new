import { expect, it } from 'vitest';
import { checkClosure, checkDelivery, checkReplicas, type Delivery } from './realtime-replicas-check.ts';

const first = { pid: 101, port: 8001 };
const second = { pid: 102, port: 8002 };
const alice: Delivery = { type: 'member', memberId: 'alice', position: 2, generation: 0 };
const bob: Delivery = { type: 'member', memberId: 'bob', position: 4, generation: 0 };
const refused: Delivery = { type: 'refused', position: 0, generation: 0 };
const resync: Delivery = { type: 'resync', position: 0, generation: 1 };
const expected = [alice, bob];

function acceptsValidEvidence() {
  checkReplicas(first, second);
  checkDelivery(expected, expected);
  checkClosure([refused], 1008, 1008, 'refused');
  checkClosure([resync], 1013, 1013, 'resync');
}
it('accepts distinct processes, ordered delivery with numeric gaps and safe closure',
  acceptsValidEvidence);

function rejectsRepeatedProcess() {
  function check() {
    checkReplicas(first, { ...second, pid: first.pid });
  }
  expect(check).toThrow();
}
it('rejects one process presented as two servers', rejectsRepeatedProcess);
function rejectsRepeatedPort() {
  function check() {
    checkReplicas(first, { ...second, port: first.port });
  }
  expect(check).toThrow();
}
it('rejects two identities using one port', rejectsRepeatedPort);

const corruptDeliveries = [
  [alice], [alice, alice, bob], [bob, alice],
  [alice, { ...bob, generation: 1 }], [alice, { ...bob, position: 5 }],
  [alice, { ...bob, memberId: 'other' }],
];
function rejectsBadDelivery(actual: Delivery[]) {
  function check() {
    checkDelivery(actual, expected);
  }
  expect(check).toThrow();
}
it.each(corruptDeliveries.map(asCase))('rejects missing, duplicate or changed delivery %#',
  rejectsBadDelivery);
function asCase(delivery: Delivery[]): [Delivery[]] {
  return [delivery];
}

function rejectsStaleGeneration() {
  function check() {
    checkClosure([bob], 1013, 1013, 'resync');
  }
  expect(check).toThrow();
}
it('rejects protected delivery instead of a stale-generation reset', rejectsStaleGeneration);
function rejectsLeak(messages: Delivery[]) {
  function check() {
    checkClosure(messages, 1008, 1008, 'refused');
  }
  expect(check).toThrow();
}
it.each([[refused, bob], [bob, refused]].map(asCase))(
  'rejects protected records around refusal %#', rejectsLeak);
function rejectsWrongClosure() {
  function check() {
    checkClosure([refused], 1000, 1008, 'refused');
  }
  expect(check).toThrow();
}
it('rejects an incorrect close outcome', rejectsWrongClosure);

const staleResets = [
  [resync, bob], [bob, resync],
  [{ ...resync, generation: 0 }],
  [{ ...resync, position: 9 }],
  [{ ...resync, memberId: 'foreign' }],
  [{ type: 'ready' as const, position: 0, generation: 1 }],
];
function rejectsUnsafeReset(messages: Delivery[]) {
  function check() {
    checkClosure(messages, 1013, 1013, 'resync', 1);
  }
  expect(check).toThrow();
}
it.each(staleResets.map(asCase))(
  'rejects a foreign record or stale generation during reset %#', rejectsUnsafeReset);

function checksExactReset() {
  checkClosure([resync], 1013, 1013, 'resync', 1);
  function wrongCode() {
    checkClosure([resync], 1008, 1013, 'resync', 1);
  }
  expect(wrongCode).toThrow();
}
it('requires the current generation and retry close code', checksExactReset);
