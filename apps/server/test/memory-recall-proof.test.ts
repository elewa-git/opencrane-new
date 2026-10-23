import { createHmac } from 'node:crypto';
import { expect, it } from 'vitest';
import type { MemoryContext } from '@opencrane/models';
import { MemoryRefused } from '../src/memory/access.ts';
import { checkRecallProof, recallProof, recallProofBytes } from '../src/memory/recall-proof.ts';

const secret = 'test-only-recall-proof-secret';
const context: MemoryContext = { silo: 'test', requester: 'alice', assistant: 'assistant',
  computer: 'computer', generation: 1, conversation: 'conversation', turn: 'turn',
  thread: 'thread', operation: 'remember', scopes: ['a'.repeat(64)], contentAccess: 'private',
  bodyDigest: 'b'.repeat(64), callId: 'call',
  dispatch: { permitDigest: 'a'.repeat(64), backendGeneration: 'memory-instance',
    schemaDigest: 'b'.repeat(64), policyRevision: 1 },
  requestId: '11111111-1111-4111-8111-111111111111', contextPosition: 1, iat: 1, exp: 3 };
const fact = { memoryId: 'fact', revision: 1 };
const dependency = { scopeId: context.scopes[0]!, ...fact };
const inputGeneration = 'saved-input';
const proof = recallProof(secret, context, [fact], inputGeneration);

function check(value: string, selected = context, dependencies = [dependency]) {
  return function verify() {
    checkRecallProof(secret, selected, value, dependencies, inputGeneration);
  };
}
function completeEvidence() {
  expect(check(proof)).not.toThrow();
  const earlier = { ...dependency, memoryId: 'earlier-page' };
  expect(check(proof, context, [earlier, dependency])).not.toThrow();
}
it('accepts a page proof within the full loaded dependency set', completeEvidence);

function hmac() {
  const [encoded, signed] = proof.split('.');
  const wrong = Buffer.from(signed!, 'base64url');
  wrong[0] = wrong[0]! ^ 1;
  const forged = `${encoded!}.${wrong.toString('base64url')}`;
  expect(Buffer.from(forged.split('.')[1]!, 'base64url')).toHaveLength(32);
  expect(check(forged)).toThrow('Recall proof signature invalid');
}
it('refuses a wrong HMAC with the same decoded length', hmac);

function signatureLength() {
  const [encoded] = proof.split('.');
  const signed = Buffer.alloc(31).toString('base64url');
  expect(check(`${encoded!}.${signed}`)).toThrow('Recall proof signature length invalid');
}
it('refuses a signature with the wrong decoded length', signatureLength);

const bindings = [
  { silo: 'other' }, { requester: 'bob' }, { assistant: 'other' }, { computer: 'other' },
  { generation: 2 }, { conversation: 'other' }, { turn: 'other' }, { thread: 'other' },
  { contentAccess: 'shared_only' }, { scopes: ['c'.repeat(64)] },
];
function refusesBinding(changed: object) {
  const selected = Object.assign({}, context, changed);
  expect(check(proof, selected)).toThrow('Recall proof thread mismatch');
}
it.each(bindings)('binds recalled references independently to %j', refusesBinding);

function refusesPlaceholder(reason: string) {
  const unavailable = { ...fact, reason };
  const excludedProof = recallProof(secret, context, [unavailable], inputGeneration);
  expect(check(excludedProof)).toThrow('Recall proof dependency not returned');
}
it.each(['page_limit', 'destroyed', 'quarantined'])('excludes %s references', refusesPlaceholder);

function structure() {
  expect(check(`${proof}.extra`)).toThrow('Recall proof structure invalid');
  expect(check(proof, context, [])).toThrow('Recall proof dependencies missing');
  expect(check('.signature')).toThrow('Recall proof structure invalid');
  expect(check('payload.')).toThrow('Recall proof structure invalid');
}
it('refuses extra proof segments and empty lineage', structure);
const dependencies = [
  { selected: { ...dependency, scopeId: 'c'.repeat(64) },
    reason: 'Recall proof dependency scope mismatch' },
  { selected: { ...dependency, revision: 2 }, reason: 'Recall proof dependency not returned' },
  { selected: { ...dependency, memoryId: 'unreturned' },
    reason: 'Recall proof dependency not returned' },
];
function refusesDependency(testCase: typeof dependencies[number]) {
  expect(check(proof, context, [testCase.selected])).toThrow(testCase.reason);
}
it.each(dependencies)('checks dependency scope, id and revision independently: %j',
  refusesDependency);

function signText(payload: string) {
  const encoded = Buffer.from(payload).toString('base64url');
  const hash = createHmac('sha256', secret);
  hash.update(`memory-recall:${encoded}`);
  return `${encoded}.${hash.digest('base64url')}`;
}
function signPayload(payload: unknown) {
  return signText(JSON.stringify(payload));
}
function invalidJson() {
  expect(check(signText('{'))).toThrow('Recall proof JSON invalid');
}
it('refuses signed invalid JSON', invalidJson);

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
  expect(check(signPayload(payload))).toThrow('Recall proof payload invalid');
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
  const oversized = signText(padded);
  expect(check(oversized)).toThrow('Recall proof byte limit exceeded');
}
it('bounds decoded proof bytes even with valid JSON and bindings', decodedBounds);

function refusesInputGeneration() {
  const stale = recallProof(secret, context, [fact], 'another-input');
  expect(check(stale)).toThrow('Recall proof thread mismatch');
}
it('refuses a valid signature for another input generation', refusesInputGeneration);

function exactProofBytes() {
  const generation = 'x'.repeat(200);
  const largest = { memoryId: 'x'.repeat(200), revision: Number.MAX_SAFE_INTEGER };
  const facts = Array<typeof largest>(20).fill(largest);
  const signed = recallProof(secret, context, facts, generation);
  const withoutProof = Buffer.byteLength(JSON.stringify({ facts }));
  const withProof = Buffer.byteLength(JSON.stringify({ facts, recallProof: signed }));
  expect(recallProofBytes(secret, context, 20, generation)).toBe(withProof - withoutProof);
}
it('reserves the exact proof field bytes including the saved input generation', exactProofBytes);

function refusesOtherTargetRevision(operation: 'correct' | 'forget') {
  const selectedContext = { ...context, operation };
  const oldReference = { ...dependency, revision: 1 };
  const target = { ...dependency, revision: 2 };
  // Include both revisions so the separate returned-reference check accepts either proof.
  const loaded = [oldReference, target];
  const currentProof = recallProof(secret, selectedContext, [target], inputGeneration);
  checkRecallProof(secret, selectedContext, currentProof, loaded, inputGeneration, target);

  const oldProof = recallProof(secret, selectedContext, [oldReference], inputGeneration);
  function checkOldProof() {
    checkRecallProof(secret, selectedContext, oldProof, loaded, inputGeneration, target);
  }
  expect(checkOldProof).toThrow(MemoryRefused);
}
it.each(['correct', 'forget'] as const)(
  'requires the exact %s target revision even when both revisions are dependencies',
  refusesOtherTargetRevision);
