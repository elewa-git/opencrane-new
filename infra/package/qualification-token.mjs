import assert from 'node:assert/strict';

export function assertMemberTokenRefusal(status, body) {
  assert.equal(body.reason, 'token_used', 'A member reused the owner token');
}
