import { createHmac } from 'node:crypto';
import { expect, it } from 'vitest';
import type { MemoryContext } from '@opencrane/models';
import { checkRecallProof, recallProof } from '../src/memory/recall-proof.ts';

const secret = 'test-only-recall-proof-secret';
const context: MemoryContext = { silo: 'test', requester: 'alice', assistant: 'assistant',
  computer: 'computer', generation: 1, conversation: 'conversation', turn: 'turn',
  thread: 'thread', operation: 'remember', scopes: ['a'.repeat(64)], contentAccess: 'private',
  bodyDigest: 'b'.repeat(64), callId: 'call',
  requestId: '11111111-1111-4111-8111-111111111111', contextPosition: 1, iat: 1, exp: 3 };
const fact = { memoryId: 'fact', revision: 1 };
const dependency = { scopeId: context.scopes[0]!, ...fact };
const proof = recallProof(secret, context, [fact]);

function check(value: string, selected = context, dependencies = [dependency]) {
  return function verify() {
    checkRecallProof(secret, selected, value, dependencies);
  };
}
function hmac() {
  expect(check(proof)).not.toThrow();
  const [encoded, signed] = proof.split('.');
  const wrong = Buffer.from(signed!, 'base64url');
  wrong[0] = wrong[0]! ^ 1;
  const forged = `${encoded!}.${wrong.toString('base64url')}`;
  expect(Buffer.from(forged.split('.')[1]!, 'base64url')).toHaveLength(32);
  expect(check(forged)).toThrow();
}
it('accepts a valid proof but refuses a wrong HMAC with the same decoded length', hmac);

const bindings = [
  { silo: 'other' }, { requester: 'bob' }, { assistant: 'other' }, { computer: 'other' },
  { generation: 2 }, { conversation: 'other' }, { turn: 'other' }, { thread: 'other' },
  { contentAccess: 'shared_only' }, { scopes: ['c'.repeat(64)] },
];
function refusesBinding(changed: object) {
  const selected = Object.assign({}, context, changed);
  expect(check(proof, selected)).toThrow();
}
it.each(bindings)('binds recalled references independently to %j', refusesBinding);

function refusesPlaceholder(reason: string) {
  const unavailable = { ...fact, reason };
  const excludedProof = recallProof(secret, context, [unavailable]);
  expect(check(excludedProof)).toThrow();
}
it.each(['page_limit', 'destroyed', 'quarantined'])('excludes %s references', refusesPlaceholder);

function structure() {
  expect(check(`${proof}.extra`)).toThrow();
  expect(check(proof, context, [])).toThrow();
}
it('refuses extra proof segments and empty lineage', structure);
const dependencies = [
  { ...dependency, scopeId: 'c'.repeat(64) }, { ...dependency, revision: 2 },
  { ...dependency, memoryId: 'unreturned' },
];
function refusesDependency(selected: typeof dependency) {
  expect(check(proof, context, [selected])).toThrow();
}
it.each(dependencies)('checks dependency scope, id and revision independently: %j',
  refusesDependency);

function signPayload(payload: unknown) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const hash = createHmac('sha256', secret);
  hash.update(`memory-recall:${encoded}`);
  return `${encoded}.${hash.digest('base64url')}`;
}
const binding = JSON.stringify([context.silo, context.requester, context.assistant,
  context.computer, context.generation, context.conversation, context.turn,
  context.thread, context.contentAccess, context.scopes]);
const invalidPayloads = [
  [binding, Array(21).fill(['fact', 1])],
  [binding, [['fact', 1], ['x'.repeat(201), 1]]],
  [binding, [['fact', 1], ['other', 0]]],
  [binding, [['fact', 1], ['other', 1.5]]],
  [binding, [['fact', 1]], 'extra'],
];
function refusesPayload(payload: unknown) {
  expect(check(signPayload(payload))).toThrow();
}
const payloadCases = invalidPayloads.map(wrapPayload);
it.each(payloadCases)('refuses a signed payload outside its bounds: %j',
  refusesPayload);
function wrapPayload(payload: unknown) {
  return [payload];
}

function decodedBounds() {
  const payload = JSON.stringify([binding, [['fact', 1]]]);
  const padded = payload + ' '.repeat(8192);
  const encoded = Buffer.from(padded).toString('base64url');
  const hash = createHmac('sha256', secret);
  hash.update(`memory-recall:${encoded}`);
  const oversized = `${encoded}.${hash.digest('base64url')}`;
  expect(check(oversized)).toThrow();
}
it('bounds decoded proof bytes even with valid JSON and bindings', decodedBounds);
