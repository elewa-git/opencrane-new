import assert from 'node:assert/strict';
import { test } from 'node:test';
import { providerFailure } from './provider-failure.ts';

function recordsSafeFailure(): void {
  const step = {
    check: 'wrong-key reachability',
    detail: 'Provider verification must report failed reachability for the wrong key.',
  };
  const error = new Error('Bearer synthetic-private-token at /private/test/credential');
  const failure = providerFailure(step, error);
  assert.deepEqual(failure, {
    check: 'wrong-key reachability',
    result: 'FAIL',
    errorType: 'Error',
    detail: 'Provider verification must report failed reachability for the wrong key.',
  });
  const receipt = JSON.stringify(failure);
  assert.equal(receipt.includes('synthetic-private-token'), false);
  assert.equal(receipt.includes('/private/test'), false);
}

test('a journey failure records its exact step and safe reason without exception content',
  recordsSafeFailure);

function refusesPrivateErrorNames(): void {
  const error = new Error('private upstream body');
  error.name = 'Bearer synthetic-private-token';
  const step = { check: 'save wrong key', detail: 'Saving the key must reach Verify.' };
  assert.equal(providerFailure(step, error).errorType, 'Error');
  error.name = 'TimeoutError';
  assert.equal(providerFailure(step, error).errorType, 'TimeoutError');
  const assertion = new assert.AssertionError({ message: 'private page content' });
  assert.equal(providerFailure(step, assertion).errorType, 'AssertionError');
  assert.equal(providerFailure(step, 'private thrown text').errorType, 'Error');
}

test('failure categories allow only fixed names and never copy an upstream error name',
  refusesPrivateErrorNames);

function recordsHttpRefusal(): void {
  const step = { check: 'invite admin', detail: 'The owner must be able to save the invitation.',
    expectedHttpStatus: 200 };
  const error = new assert.AssertionError({ actual: 503, expected: 200,
    operator: 'strictEqual', message: 'private request content' });
  assert.equal(providerFailure(step, error).detail,
    'Expected HTTP 200; received HTTP 503. The owner must be able to save the invitation.');
}

test('an HTTP refusal records its numeric status without assertion or request content',
  recordsHttpRefusal);

function recordsAmbiguousControl(): void {
  const step = { check: 'wrong-key reachability', detail: 'Read the failed verification result.' };
  const error = new Error('locator.isVisible: Error: strict mode violation: private-token /private');
  assert.equal(providerFailure(step, error).detail,
    'More than one control matched the current operation. Read the failed verification result.');
}

test('an ambiguous browser control has a specific reason without copying locator diagnostics',
  recordsAmbiguousControl);

function refusesNonHttpValues(): void {
  const step = { check: 'invite admin', detail: 'The invitation must be saved.',
    expectedHttpStatus: 200 };
  for (const actual of ['private-token /private/path', 99, 600, 200.5]) {
    const error = new assert.AssertionError({ actual, expected: 200,
      operator: 'strictEqual', message: 'private request' });
    assert.equal(providerFailure(step, error).detail, step.detail);
  }
}

test('non-HTTP assertion values never enter the public failure reason', refusesNonHttpValues);

function recordsDisconnectedRequest(): void {
  const step = { check: 'read spending', detail: 'Read the projected budget.' };
  const error = new Error([
    'apiRequestContext.get: socket hang up',
    'Call log:',
    '  - cookie: synthetic-session=private',
  ].join('\n'));
  const failure = providerFailure(step, error);
  assert.equal(failure.detail, 'The browser request lost its connection. Read the projected budget.');
  assert.doesNotMatch(JSON.stringify(failure), /cookie|synthetic-session/u);
}

test('a disconnected request keeps the cause without copying its HTTP headers',
  recordsDisconnectedRequest);
