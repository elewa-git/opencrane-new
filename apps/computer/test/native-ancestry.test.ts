import capture from '../../../docs/process/p4-11-pr3a/capture.json' with { type: 'json' };
import { expect, it } from 'vitest';
import { assertEarlyAncestry } from './native-ancestry-proof.ts';

// Exercise the acceptance rule with invented data, never as native proof.
function example() {
  return {
    source: 'app-server-stdio', method: 'item/started', spawn: 'spawn-1',
    type: 'subAgentActivity', activity: 'started',
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
  function check() { assertEarlyAncestry(example(), context); }
  expect(check).not.toThrow();
}
it('accepts a complete synthetic early observation', acceptsCompleteExample);

const invalid = [
  ['unknown item', { type: 'invented' }],
  ['ended child activity', { activity: 'completed' }],
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
  function check() { assertEarlyAncestry(observation, context); }
  expect(check).toThrow('Early ancestry unproven');
}
it.each(invalid)('refuses %s', refusesInvalidExample);

function refusesEndedRoot() {
  const ended = { ...context, ended: true };
  function check() { assertEarlyAncestry(example(), ended); }
  expect(check).toThrow('Early ancestry unproven');
}
it('refuses an ended root', refusesEndedRoot);

function acceptsSecondDepth() {
  const parent = { ...context, parent: 'child-a', parentTurn: 'turn-child' };
  const observation = { ...example(), sender: 'child-a', receiver: 'grandchild-a',
    parentTurn: 'turn-child', readParent: 'child-a' };
  function checkParent() { assertEarlyAncestry(observation, parent); }
  expect(checkParent).not.toThrow();
  function check() { assertEarlyAncestry(observation, context); }
  expect(check).toThrow('Early ancestry unproven');
}
it('binds the second depth to its direct parent', acceptsSecondDepth);

type Observation = typeof capture.observations[number];
function callsFor(thread: string) {
  function matches(item: Observation) { return item.kind === 'call' && item.thread === thread; }
  return capture.observations.filter(matches);
}
function checksCapturedAncestry() {
  let children = 0;
  for (const item of capture.observations) {
    if (item.kind !== 'activity' || item.activity !== 'started'
      || item.method !== 'item/started') continue;
    children++;
    const firstCall = callsFor(item.receiver)[0]!;
    function readForChild(entry: Observation) {
      return entry.kind === 'read' && entry.thread === item.receiver;
    }
    const read = capture.observations.find(readForChild)!;
    const observed = { ...item, source: 'app-server-stdio', root: 'fixture-root',
      generation: 1, spawnOrder: item.order, readOrder: read.order,
      readParent: read.parent, firstCallOrder: firstCall.order };
    const parent = { ...context, root: 'fixture-root', parent: item.sender,
      parentTurn: item.parentTurn, boundThreads: [] };
    function check() { assertEarlyAncestry(observed, parent); }
    expect(check).not.toThrow();
    const missingRead = { ...observed, readParent: undefined };
    function checkMissingRead() { assertEarlyAncestry(missingRead, parent); }
    expect(checkMissingRead).toThrow();
  }
  expect(children).toBe(4);
  expect(capture.failure).toBe(false);
  expect(capture.version).toBe('codex-cli 0.159.2');
}
it('checks four captured links with synthetic process context only', checksCapturedAncestry);

function checksRetryAndIdentityLimits() {
  let retries = 0;
  let distinctCalls = 0;
  for (const first of capture.observations) {
    if (first.kind !== 'call') continue;
    const calls = callsFor(first.thread!);
    if (calls[0] !== first) continue;
    const next = calls[1]!;
    expect(next).toBeDefined();
    expect(next.sameInput).toBe(first.sameInput);
    expect(next.identities).toEqual(first.identities);
    expect(next.metadata).toEqual(first.metadata);
    if (first.lostReply) {
      expect(next.bytes).toBe(first.bytes);
      retries++;
    } else {
      expect(next.bytes).not.toBe(first.bytes);
      distinctCalls++;
    }
  }
  expect(retries).toBe(2);
  expect(distinctCalls).toBe(4);
}
it('records exact native retries but repeated identities on separate calls',
  checksRetryAndIdentityLimits);

function excludesPrivateValues() {
  const saved = JSON.stringify(capture);
  expect(saved).not.toMatch(/offline-root|offline-child|offline-grandchild|credential-canary/u);
  expect(saved).not.toMatch(/Bearer |Offline fixture finished/u);
}
it('keeps prompts, replies and credential canaries out of the saved capture', excludesPrivateValues);

function keepsRefusalsSafe() {
  const observation = { ...example(), source: 'credential-canary-private' };
  try {
    assertEarlyAncestry(observation, context);
    throw new Error('Expected refusal');
  } catch (error) {
    expect(String(error)).toContain('Early ancestry unproven');
    expect(JSON.stringify(error)).not.toContain('credential-canary-private');
    expect(String(error)).not.toContain('credential-canary-private');
  }
}
it('keeps supplied values out of refusal errors', keepsRefusalsSafe);
