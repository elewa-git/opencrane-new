import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { APIRequestContext } from 'playwright';
import type { OwnershipCommand, OwnershipResponse } from '@opencrane/protocol';

export const separateOwnerId = 'jente-rosseel';
export const browserOwnerId = 'zitadel-owner';
export const browserMemberId = 'zitadel-member';

export async function readOwners(client: APIRequestContext, origin: string) {
  const response = await client.get(`${origin}/api/ownership`);
  assert.equal(response.status(), 200, 'The fixture owner can read ownership');
  return await response.json() as OwnershipResponse;
}

export async function changeOwnership(
  client: APIRequestContext,
  origin: string,
  action: OwnershipCommand['action'],
  successorId?: string,
): Promise<void> {
  const current = await readOwners(client, origin);
  const commandId = `journey-ownership-${randomUUID()}`;
  const common = { commandId, expectedSequence: current.sequence };
  let data: OwnershipCommand;
  if (action === 'transfer') {
    assert(successorId);
    data = { ...common, action, successorId };
  } else {
    data = { ...common, action };
  }
  const response = await client.post(`${origin}/api/ownership`, {
    headers: { origin }, data,
  });
  assert.equal(response.status(), 200, `The fixture ${action} command must be accepted`);
  await waitForChange(client, `${origin}/api/ownership/changes/${commandId}`);
}

export async function changeMemberRole(
  client: APIRequestContext,
  origin: string,
  memberId: string,
  newRole: 'admin' | 'member',
): Promise<void> {
  const response = await client.get(`${origin}/api/members/${memberId}`);
  assert.equal(response.status(), 200);
  const member = await response.json() as { memberSequence: number; role: string };
  if (member.role === newRole) return;
  const commandId = `journey-role-${randomUUID()}`;
  const data = { commandId, expectedSequence: member.memberSequence, newRole };
  const result = await client.post(`${origin}/api/members/${memberId}/role`, {
    headers: { origin }, data,
  });
  assert.equal(result.status(), 200, 'The fixture role change must be accepted');
  await waitForChange(client, `${origin}/api/members/${memberId}/changes/${commandId}`);
}

export async function waitForChange(client: APIRequestContext, url: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const response = await client.get(url);
    assert.equal(response.status(), 200, 'The accepted command must have a saved receipt');
    const body = await response.json() as {
      projection: { content: string; iam: string };
    };
    if (body.projection.content === 'current' && body.projection.iam === 'current') return;
    await delay(100);
  }
  throw new Error('The accepted ownership fixture command did not finish applying');
}

export async function prepareOwnershipJourney(
  separateOwner: APIRequestContext,
  browserOwner: APIRequestContext,
  origin: string,
): Promise<void> {
  const current = await readOwners(separateOwner, origin);
  assert.equal(current.viewer.memberId, separateOwnerId);
  assert.equal(current.viewer.role, 'owner');
  const alreadyOwner = current.owners.some(isBrowserOwner);
  if (!alreadyOwner) {
    await changeOwnership(separateOwner, origin, 'transfer', browserOwnerId);
  }
  await changeOwnership(separateOwner, origin, 'step_down');
  const prepared = await readOwners(browserOwner, origin);
  assert.equal(prepared.viewer.role, 'owner');
  assert.deepEqual(prepared.owners.map(readOwnerId), [browserOwnerId],
    'Start the browser check with one owner, without dropping the separate test user');
}

export async function restoreOwnershipJourney(
  separateOwner: APIRequestContext,
  browserMember: APIRequestContext,
  origin: string,
): Promise<void> {
  await changeOwnership(browserMember, origin, 'transfer', separateOwnerId);
  await changeOwnership(browserMember, origin, 'step_down');
  await changeMemberRole(separateOwner, origin, browserMemberId, 'member');
  await changeMemberRole(separateOwner, origin, browserOwnerId, 'admin');
  const restored = await readOwners(separateOwner, origin);
  assert.deepEqual(restored.owners.map(readOwnerId), [separateOwnerId]);
}

function isBrowserOwner(owner: OwnershipResponse['owners'][number]): boolean {
  return owner.memberId === browserOwnerId;
}

function readOwnerId(owner: OwnershipResponse['owners'][number]): string {
  return owner.memberId;
}
