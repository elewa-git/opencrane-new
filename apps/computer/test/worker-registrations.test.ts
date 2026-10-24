import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { workerRegistrations } from '../src/worker-registrations.ts';
import { workerRequest } from '../src/worker-request.ts';

function fixture() {
  let time = 1000;
  function now() {
    return time;
  }
  function advance() {
    time = 2000;
  }
  const owner = { siloId: 'silo-1', computerId: 'computer-1', generation: 3 };
  const binding = { ...owner, executorId: 'executor-1', personId: 'person-1',
    processId: 'process-1' };
  const params = { processId: binding.processId,
    argv: ['git', 'clone', '--no-checkout', 'https://github.com/elewa-git/demo.git'],
    cwd: 'file:///workspace', env: {}, tty: false, pipeStdin: false, arg0: null,
    metadata: { threadId: 'thread-1', toolCallId: 'call-1' } };
  const hash = createHash('sha256');
  hash.update(JSON.stringify([params.argv, params.cwd, '']));
  const registration = { ...binding, ...params.metadata, turnId: 'turn-1',
    operationId: 'operation-1', operationDigest: hash.digest('hex'),
    host: 'github.com', port: 443, expiresAt: 2000 };
  const store = workerRegistrations(owner, now);
  function register() {
    store.register(registration, '');
  }
  function frame() {
    return Buffer.from(`${JSON.stringify({ id: 1, method: 'process/start', params })}\n`);
  }
  function validate() {
    return workerRequest(frame(), store.lookup, binding, now());
  }
  register();
  return { owner, binding, registration, params, store, register, frame, validate, advance };
}

async function racesHandles() {
  const test = fixture();
  const first = test.store.lookup(test.binding)!;
  const second = test.store.lookup(test.binding)!;
  function lookupFirst() {
    return first;
  }
  function lookupSecond() {
    return second;
  }
  function claimFirst() {
    return workerRequest(test.frame(), lookupFirst, test.binding, 1000);
  }
  function claimSecond() {
    return workerRequest(test.frame(), lookupSecond, test.binding, 1000);
  }
  const firstAttempt = Promise.resolve().then(claimFirst);
  const secondAttempt = Promise.resolve().then(claimSecond);
  const results = await Promise.allSettled([firstAttempt, secondAttempt]);
  expect(results[0].status).toBe('fulfilled');
  expect(results[1]).toMatchObject({ status: 'rejected',
    reason: new Error('worker_request_refused') });
  expect(test.validate).toThrow('worker_request_refused');
}
it('allows only one plan when two saved lookup handles race to consume', racesHandles);

function invalidatesHandles(reason: string) {
  const test = fixture();
  const saved = test.store.lookup(test.binding)!;
  if (reason === 'connection loss') {
    test.store.disconnect(test.binding.executorId);
  }
  if (reason === 'expiry') {
    test.advance();
  }
  if (reason === 'generation retirement') {
    test.store.dispose();
  }
  if (reason === 'replacement') {
    const replacement = { ...test.registration, operationId: 'operation-2', toolCallId: 'call-2' };
    test.store.register(replacement, '');
  }
  expect(saved.consume()).toBe(false);
  expect(test.validate).toThrow('worker_request_refused');
  // A late duplicate must not restore the removed record.
  try { test.register(); } catch (error) {
    expect(error).toEqual(new Error('worker_registration_refused'));
  }
  expect(saved.consume()).toBe(false);
  expect(test.validate).toThrow('worker_request_refused');
  if (reason === 'replacement') {
    test.params.metadata.toolCallId = 'call-2';
    expect(test.validate().identity.operationId).toBe('operation-2');
  }
}
it.each(['connection loss', 'expiry', 'generation retirement', 'replacement'])(
  'invalidates saved handles after %s and never restores them on duplicate delivery',
  invalidatesHandles);

function preservesConsumed() {
  const test = fixture();
  const saved = test.store.lookup(test.binding)!;
  test.register();
  expect(test.validate().execution).toBe('disabled');
  test.register();
  expect(saved.consume()).toBe(false);
  expect(test.validate).toThrow('worker_request_refused');
}
it('makes identical registration idempotent without resetting consumed state', preservesConsumed);

const bindingFields = ['executorId', 'personId', 'siloId', 'computerId', 'processId',
  'generation'] as const;
function refusesCopied(field: typeof bindingFields[number]) {
  const test = fixture();
  const foreign = { ...test.binding };
  Object.assign(foreign, { [field]: field === 'generation' ? 4 : 'foreign' });
  test.params.processId = foreign.processId;
  function copied() {
    return workerRequest(test.frame(), test.store.lookup, foreign, 1000);
  }
  expect(test.store.lookup(foreign)).toBeUndefined();
  expect(copied).toThrow('worker_request_refused');
  test.params.processId = test.binding.processId;
  expect(test.validate().identity).toEqual(test.registration);
}
it.each(bindingFields)('refuses copied valid metadata from another %s', refusesCopied);

function refusesConflict(field: string) {
  const test = fixture();
  const saved = test.store.lookup(test.binding)!;
  const conflict = { ...test.registration };
  let value: string | number = 'conflict';
  if (field === 'generation') {
    value = 4;
  }
  if (field === 'port') {
    value = 444;
  }
  if (field === 'expiresAt') {
    value = 3000;
  }
  if (field === 'operationDigest') {
    value = 'a'.repeat(64);
  }
  Object.assign(conflict, { [field]: value });
  function registerConflict() {
    test.store.register(conflict, '');
  }
  expect(registerConflict).toThrow(/^worker_registration_refused$/);
  expect(saved.consume()).toBe(true);
}
it.each([...bindingFields, 'threadId', 'toolCallId', 'turnId', 'operationDigest',
  'host', 'port', 'expiresAt'])('refuses conflicting registration of %s', refusesConflict);

function keepsImmutable() {
  const test = fixture();
  const saved = test.store.lookup(test.binding)!;
  const original = { ...test.registration };
  test.registration.turnId = 'mutated';
  test.owner.generation = 99;
  Object.assign(test.registration, { bearer: 'private-canary' });
  expect(saved.registration).toEqual(original);
  expect(Object.isFrozen(saved)).toBe(true);
  expect(Object.isFrozen(saved.registration)).toBe(true);
  expect(test.validate().identity).toEqual(original);
}
it('copies and freezes only the exact reviewed registration fields', keepsImmutable);

function preservesAfterInvalidValidation(reason: string) {
  const test = fixture();
  const frame = test.frame();
  let invalid = frame;
  if (reason === 'frame') {
    invalid = Buffer.alloc(65_537, 32);
  }
  if (reason === 'digest') {
    test.params.argv[3] = 'https://github.com/other/repo.git';
  }
  if (reason === 'destination') {
    test.params.argv[3] = 'https://example.com/other/repo.git';
  }
  if (reason === 'metadata') {
    test.params.metadata.toolCallId = 'forged';
  }
  if (reason !== 'frame') {
    invalid = test.frame();
  }
  function refused() {
    return workerRequest(invalid, test.store.lookup, test.binding, 1000);
  }
  expect(refused).toThrow(/^worker_request_refused$/);
  expect(workerRequest(frame, test.store.lookup, test.binding, 1000).execution).toBe('disabled');
}
it.each(['frame', 'digest', 'destination', 'metadata'])(
  'keeps a current registration usable after invalid %s validation', preservesAfterInvalidValidation);

function rechecksClockAtClaim() {
  const test = fixture();
  const saved = test.store.lookup(test.binding)!;
  function staleLookup() {
    return saved;
  }
  test.advance();
  function validate() {
    return workerRequest(test.frame(), staleLookup, test.binding, 1000);
  }
  expect(validate).toThrow('worker_request_refused');
  expect(test.store.lookup(test.binding)).toBeUndefined();
  expect(test.register).toThrow(/^worker_registration_refused$/);
}
it('checks the current clock at claim even when validation started before expiry',
  rechecksClockAtClaim);

function boundsRegistration(kind: string) {
  const test = fixture();
  const replacement = { ...test.registration, operationId: 'operation-2' };
  let input = '';
  if (kind === 'input') {
    input = 'é'.repeat(32_769);
  }
  if (kind === 'record') {
    replacement.threadId = 'é'.repeat(32_769);
  }
  function oversized() {
    test.store.register(replacement, input);
  }
  expect(oversized).toThrow(/^worker_registration_refused$/);
  expect(test.validate().execution).toBe('disabled');
}
it.each(['input', 'record'])('bounds %s bytes without replacing a live record', boundsRegistration);

function boundsInputAndConflict() {
  const test = fixture();
  const replacement = { ...test.registration, operationId: 'operation-2' };
  const input = 'é'.repeat(32_768);
  test.store.register(replacement, input);
  expect(test.store.lookup(test.binding)?.input).toBe(input);
  function conflict() {
    test.store.register(replacement, 'private-canary');
  }
  expect(conflict).toThrow(/^worker_registration_refused$/);
  expect(test.store.lookup(test.binding)?.input).toBe(input);
}
it('accepts 64 KiB input and refuses a conflicting input without revealing it', boundsInputAndConflict);

function boundsOperations() {
  const test = fixture();
  const second = { ...test.registration, executorId: 'executor-2', operationId: 'operation-2' };
  const third = { ...test.registration, executorId: 'executor-3', operationId: 'operation-3' };
  test.store.register(second, '');
  const saved = test.store.lookup(test.binding)!;
  function extra() {
    test.store.register(third, '');
  }
  expect(extra).toThrow(/^worker_registration_refused$/);
  expect(saved.consume()).toBe(true);
  expect(extra).toThrow(/^worker_registration_refused$/);
  test.store.disconnect(second.executorId);
  extra();
  expect(test.store.lookup(third)?.consume()).toBe(true);
}
it('limits each computer to two current operations without evicting or releasing consumed work',
  boundsOperations);

function boundsReplayHistory() {
  const test = fixture();
  for (let index = 2; index <= 1024; index++) {
    const replacement = { ...test.registration, operationId: `operation-${index}` };
    test.store.register(replacement, '');
  }
  const saved = test.store.lookup(test.binding)!;
  function extra() {
    const replacement = { ...test.registration, operationId: 'operation-1025' };
    test.store.register(replacement, '');
  }
  expect(extra).toThrow(/^worker_registration_refused$/);
  test.register();
  expect(test.store.lookup(test.binding)?.registration.operationId).toBe('operation-1024');
  expect(saved.consume()).toBe(true);
}
it('bounds replay history and refuses new work instead of forgetting previous registrations',
  boundsReplayHistory);

function releasesExpiredRecords() {
  const test = fixture();
  const second = { ...test.registration, executorId: 'executor-2', operationId: 'operation-2' };
  test.store.register(second, '');
  const saved = test.store.lookup(second)!;
  test.advance();
  const next = { ...second, operationId: 'operation-3', expiresAt: 3000 };
  test.store.register(next, '');
  function revive() {
    const changedExpiry = { ...second, expiresAt: 3000 };
    test.store.register(changedExpiry, '');
  }
  expect(revive).toThrow(/^worker_registration_refused$/);
  expect(saved.consume()).toBe(false);
  expect(test.store.lookup(next)?.consume()).toBe(true);
}
it('releases expired slots but refuses renewed expiry for a previous operation', releasesExpiredRecords);

function validatesInstall() {
  const test = fixture();
  test.params.argv = ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'];
  const input = JSON.stringify({ lockfileVersion: 3, packages: {
    '': { dependencies: { demo: '1.2.3' } },
    'node_modules/demo': { version: '1.2.3',
      resolved: 'https://registry.npmjs.org/demo/-/demo-1.2.3.tgz',
      integrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}` },
  } });
  const hash = createHash('sha256');
  hash.update(JSON.stringify([test.params.argv, test.params.cwd, input]));
  const registration = { ...test.registration, operationId: 'operation-2',
    host: 'registry.npmjs.org', operationDigest: hash.digest('hex') };
  test.store.register(registration, input);
  const json = test.frame().toString('utf8').trimEnd();
  const frame = Buffer.from(`${json.padEnd(65_535, ' ')}\n`);
  const plan = workerRequest(frame, test.store.lookup, test.binding, 1000);
  expect(plan.identity).toEqual(registration);
  expect(plan.argv[0]).toBe('/usr/bin/npm');
  expect(plan.execution).toBe('disabled');
  expect(test.validate).toThrow('worker_request_refused');
}
it('validates a maximum-size npm frame with the real store and its private input', validatesInstall);

function disposesWithoutLogging() {
  const test = fixture();
  const replacement = { ...test.registration, operationId: 'operation-2' };
  test.store.register(replacement, 'private-canary');
  const saved = test.store.lookup(test.binding)!;
  const stdout = vi.spyOn(process.stdout, 'write');
  const stderr = vi.spyOn(process.stderr, 'write');
  try {
    test.store.dispose();
    test.store.dispose();
    expect(saved.consume()).toBe(false);
    expect(test.store.lookup(test.binding)).toBeUndefined();
    expect(test.register).toThrow(/^worker_registration_refused$/);
    const restarted = workerRegistrations(test.owner);
    expect(restarted.lookup(test.binding)).toBeUndefined();
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
  }
}
it('disposes permanently without logging input and restores no permission on restart',
  disposesWithoutLogging);
