import assert from 'node:assert/strict';
import { lstat, realpath, rm } from 'node:fs/promises';
import { z } from 'zod';

// Keep this one-time repair separate from setup so setup cannot recreate the account.
type Api = (path: string, body?: unknown, method?: string) => Promise<unknown>;
const orgId = '393311211338337681';
const ownerId = '378127409465593948';
const userSchema = z.object({
  id: z.string().regex(/^[\w-]+$/u),
  userName: z.string(),
  machine: z.object({}),
  details: z.object({ resourceOwner: z.literal(orgId) }),
});
const userResponseSchema = z.object({ user: userSchema });
const usersSchema = z.object({ result: z.array(userSchema).max(1).default([]) });
const membersSchema = z.object({
  result: z.array(z.object({ userId: z.string(), roles: z.array(z.string()) })).max(1).default([]),
});
// Treat an omitted count as zero, as Zitadel omits default values in empty replies.
const keysSchema = z.object({
  result: z.array(z.object({ id: z.string().regex(/^[\w-]+$/u) })).max(100).default([]),
  details: z.object({ totalResult: z.coerce.number().int().nonnegative().default(0) }),
});

async function checkLocalDirectory(path: string) {
  try {
    const directory = await lstat(path);
    assert(directory.isDirectory(), 'Refusing an unsafe credential directory');
    assert(await realpath(path) === path, 'Refusing a linked credential directory');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
}

async function directoryUser(api: Api, slot: string) {
  const userName = `opencrane2-dev-ci-${slot}-directory`;
  const query = { userNameQuery: { userName, method: 'TEXT_QUERY_METHOD_EQUALS' } };
  const search = { query: { limit: 2 }, queries: [query] };
  const response = await api('/management/v1/users/_search', search);
  const found = usersSchema.parse(response).result[0];
  if (!found) return undefined;
  assert(found.id !== ownerId, 'Refusing the owner user');
  assert(found.userName === userName, 'Refusing another user');
  const userResponse = await api(`/management/v1/users/${found.id}`);
  const user = userResponseSchema.parse(userResponse).user;
  assert(user.id === found.id && user.userName === userName, 'Refusing another user');
  return user.id;
}

async function directoryMembership(api: Api, userId: string) {
  const query = { userIdQuery: { userId } };
  const search = { query: { limit: 2 }, queries: [query] };
  const response = await api('/management/v1/orgs/me/members/_search', search);
  const member = membersSchema.parse(response).result[0];
  if (member) {
    assert(member.userId === userId, 'Refusing another membership');
    assert.deepEqual(member.roles, ['ORG_OWNER_VIEWER'], 'Refusing unexpected directory roles');
  }
  return member;
}

async function directoryKeys(api: Api, userId: string) {
  const search = { query: { limit: 100 } };
  const response = await api(`/management/v1/users/${userId}/keys/_search`, search);
  const keys = keysSchema.parse(response);
  assert(keys.details.totalResult === keys.result.length, 'Refusing an incomplete key list');
  return keys.result;
}

async function removeRemoteDirectory(api: Api, slot: string) {
  const userId = await directoryUser(api, slot);
  if (!userId) return;
  // Check all returned resources before the first deletion.
  const member = await directoryMembership(api, userId);
  const keys = await directoryKeys(api, userId);
  if (member) {
    await api(`/management/v1/orgs/me/members/${userId}`, undefined, 'DELETE');
    assert(!await directoryMembership(api, userId), 'Directory membership removal incomplete');
  }
  for (const key of keys) {
    await api(`/management/v1/users/${userId}/keys/${key.id}`, undefined, 'DELETE');
  }
  assert((await directoryKeys(api, userId)).length === 0, 'Directory key removal incomplete');
  await api(`/management/v1/users/${userId}`, undefined, 'DELETE');
  assert(!await directoryUser(api, slot), 'Directory user removal incomplete');
}

export async function removeDirectory(api: Api, slot: string, home: string) {
  assert(slot === '1' || slot === '2', 'Directory cleanup needs a secondary slot');
  const credentialDirectories = [
    `${home}/.config/opencrane/dev-stack-ci-${slot}`,
    `${home}/.config/opencrane/dev-stack-${slot}`,
  ];
  for (const path of credentialDirectories) await checkLocalDirectory(path);
  const response = await api('/management/v1/orgs/me');
  const orgSchema = z.object({ org: z.object({
    id: z.literal(orgId), name: z.literal('OpenCrane 2 Dev'),
  }) });
  orgSchema.parse(response);
  await removeRemoteDirectory(api, slot);
  for (const path of credentialDirectories) {
    await rm(`${path}/zitadel-directory-key`, { force: true });
  }
  return { organisation: 'PASS', membership: 'PASS', keys: 'PASS', user: 'PASS',
    localFiles: 'PASS' };
}
