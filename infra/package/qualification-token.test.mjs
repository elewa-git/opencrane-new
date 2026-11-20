import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertMemberTokenRefusal } from './qualification-token.mjs';

function acceptsTheDocumentedRefusalForAnotherIdentity() {
  assertMemberTokenRefusal(409, { status: 'refused', reason: 'owner_exists' });
}

function rejectsSuccessfulClaimsAndOtherRefusals() {
  const cases = [
    [201, { status: 'refused', reason: 'owner_exists' }],
    [409, { status: 'claimed', reason: 'owner_exists' }],
    [409, { status: 'refused', reason: 'token_used' }],
    [409, { status: 'refused', reason: 'rate_limited' }],
    [409, { status: 'refused', reason: 'owner_exists', memberId: 'new-owner' }],
  ];
  for (const [status, body] of cases) {
    function check() { assertMemberTokenRefusal(status, body); }
    assert.throws(check, { code: 'ERR_ASSERTION' });
  }
}

test('accepts the exact existing-owner refusal for the member identity',
  acceptsTheDocumentedRefusalForAnotherIdentity);
test('rejects success, owner-token reuse reasons and malformed refusal bodies',
  rejectsSuccessfulClaimsAndOtherRefusals);
