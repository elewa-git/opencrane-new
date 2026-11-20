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
