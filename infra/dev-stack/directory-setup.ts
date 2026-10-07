import assert from 'node:assert/strict';
import { z } from 'zod';

type Api = (path: string, body?: unknown, method?: string) => Promise<unknown>;
const listSchema = z.object({ result: z.array(z.object({ id: z.string() })).max(1).default([]) });
const idSchema = z.object({ userId: z.string() });
const rolesSchema = z.object({ result: z.array(z.string()) });
const membersSchema = z.object({ result: z.array(z.object({ userId: z.string(),
  roles: z.array(z.string()) })).max(1).default([]) });
const keysSchema = z.object({ result: z.array(z.unknown()).default([]) });
const keySchema = z.object({ keyDetails: z.string() });
export async function setupDirectory(api: Api, slot: string,
  exists: (file: string) => Promise<boolean>, retain: (file: string, value: string) => Promise<void>) {
  const orgId = '393311211338337681';
  const userName = `opencrane2-dev-ci-${slot}-directory`;
  const rolesResponse = await api('/management/v1/orgs/members/roles/_search', {});
  const roles = rolesSchema.parse(rolesResponse);
  assert(roles.result.includes('ORG_OWNER_VIEWER'), 'Read-only organisation role unavailable');
  const query = { userNameQuery: { userName, method: 'TEXT_QUERY_METHOD_EQUALS' } };
  const search = { queries: [query] };
  const foundResponse = await api('/management/v1/users/_search', search);
  const found = listSchema.parse(foundResponse);
  let userId = found.result[0]?.id;
  if (!userId) {
    const machine = { userName, name: userName, accessTokenType: 'ACCESS_TOKEN_TYPE_BEARER' };
    const createdResponse = await api('/management/v1/users/machine', machine);
    const created = idSchema.parse(createdResponse);
    userId = created.userId;
  }
  const ownedUserSchema = z.object({ user: z.object({ userName: z.literal(userName),
    machine: z.object({}), details: z.object({ resourceOwner: z.literal(orgId) }) }) });
  const userResponse = await api(`/management/v1/users/${userId}`);
  ownedUserSchema.parse(userResponse);
  const membershipQuery = { queries: [{ userIdQuery: { userId } }] };
  const membersResponse = await api('/management/v1/orgs/me/members/_search', membershipQuery);
  const members = membersSchema.parse(membersResponse);
  if (!members.result.length) {
    const membership = { userId, roles: ['ORG_OWNER_VIEWER'] };
    await api('/management/v1/orgs/me/members', membership);
  } else {
    assert.deepEqual(members.result[0]!.roles, ['ORG_OWNER_VIEWER'], 'Directory role must be read-only');
  }
  if (await exists('zitadel-directory-key')) return;
  // Refuse to rotate a key whose private file was lost after setup.
  const keysResponse = await api(`/management/v1/users/${userId}/keys/_search`, {});
  const keys = keysSchema.parse(keysResponse);
  assert(keys.result.length === 0, 'Existing directory key file missing');
  const keyRequest = { type: 'KEY_TYPE_JSON' };
  const keyResponse = await api(`/management/v1/users/${userId}/keys`, keyRequest);
  const key = keySchema.parse(keyResponse);
  const decoded = Buffer.from(key.keyDetails, 'base64');
  await retain('zitadel-directory-key', decoded.toString('utf8'));
}
