import assert from 'node:assert/strict';

export function assertMemberTokenRefusal(status, body) {
  assert.equal(status, 409, 'The member claim did not return the ownership conflict');
  assert.deepEqual(body, { status: 'refused', reason: 'owner_exists' });
}

export async function assertClaimRole(page, origin, expected) {
  const response = await page.request.get(`${origin}/api/chat`);
  assert.equal(response.status(), 200, 'The existing workspace became unavailable after refusal');
  const context = await response.json();
  assert.equal(context.memberId, expected.memberId, 'The claim changed the existing identity');
  assert.equal(context.role, expected.role, 'The claim changed the existing role');
}
