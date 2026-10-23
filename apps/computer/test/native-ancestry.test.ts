import { expect, it } from 'vitest';
import { assertEarlyAncestry } from './native-ancestry-proof.ts';

// Exercise the acceptance rule with invented data, never as native proof.
function example() {
  return {
    source: 'app-server-stdio', method: 'item/started', spawn: 'spawn-1',
    sender: 'root-a', receiver: 'child-a', parentTurn: 'turn-a',
    readParent: 'root-a', spawnOrder: 1, readOrder: 2, firstCallOrder: 3,
    root: 'root-a', generation: 1,
  };
}
const context = {
  root: 'root-a', parent: 'root-a', parentTurn: 'turn-a', generation: 1,
  ended: false, boundThreads: ['root-a', 'foreign-thread'],
};
function acceptsCompleteExample() {
  expect(() => assertEarlyAncestry(example(), context)).not.toThrow();
}
it('accepts a complete synthetic early observation', acceptsCompleteExample);

const invalid = [
  ['model-written ancestry', { source: 'model' }],
  ['caller header', { source: 'http' }],
  ['generated type', { source: 'generated-type' }],
  ['late completed spawn', { method: 'item/completed', spawnOrder: 4 }],
  ['late read', { readOrder: 4 }],
  ['concurrent parent', { sender: 'root-b' }],
  ['foreign thread', { readParent: 'root-b' }],
  ['reused thread', { receiver: 'foreign-thread' }],
  ['cycle', { receiver: 'root-a' }],
  ['generation change', { generation: 2 }],
  ['foreign root', { root: 'root-b' }],
  ['wrong parent turn', { parentTurn: 'turn-b' }],
  ['missing receiver', { receiver: '' }],
  ['malformed ancestry', { readParent: ['root-a'] }],
  ['missing spawn', { spawn: null }],
  ['invalid order', { firstCallOrder: NaN }],
] as const;
function refusesInvalidExample(_name: string, replacement: object) {
  const observation = { ...example(), ...replacement };
  expect(() => assertEarlyAncestry(observation, context)).toThrow('Early ancestry unproven');
}
it.each(invalid)('refuses %s', refusesInvalidExample);

function refusesEndedRoot() {
  const ended = { ...context, ended: true };
  expect(() => assertEarlyAncestry(example(), ended)).toThrow('Early ancestry unproven');
}
it('refuses an ended root', refusesEndedRoot);

function acceptsSecondDepth() {
  const parent = { ...context, parent: 'child-a', parentTurn: 'turn-child' };
  const observation = { ...example(), sender: 'child-a', receiver: 'grandchild-a',
    parentTurn: 'turn-child', readParent: 'child-a' };
  expect(() => assertEarlyAncestry(observation, parent)).not.toThrow();
  expect(() => assertEarlyAncestry(observation, context)).toThrow('Early ancestry unproven');
}
it('binds the second depth to its direct parent', acceptsSecondDepth);
