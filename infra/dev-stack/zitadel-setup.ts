import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { secondary, localOrigin } from './identity.ts';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { directory, exists, root, save, prepareDirectory } from './config.ts';

// Run under the same flock as up.sh. Never pass the PAT through argv or logs.
const issuer = 'https://weownai-oidc-8dwlat.eu1.zitadel.cloud';
const name = 'OpenCrane 2 Dev';
const origin = 'https://ocn-dev.tail00285e.ts.net';
const object = z.object({ id: z.string(), name: z.string().optional(), preferredLoginName: z.string().optional() });
const identity = z.object({ issuer: z.string(), subject: z.string() });
const userGrant = z.object({ id: z.string(), userId: z.string(), projectId: z.string(), roleKeys: z.array(z.string()),
  state: z.string(), details: z.object({ resourceOwner: z.string() }) });
let orgId: string | undefined;
async function api(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(`${issuer}${path}`, {
    method, redirect: 'error', signal: AbortSignal.timeout(30_000),
    headers: { Authorization: `Bearer ${(await readFile(process.env['ZITADEL_KEY_FILE'] ?? `${root}/.keys/.zitadel-key`, 'utf8')).trim()}`,
      'content-type': 'application/json', ...(orgId ? { 'x-zitadel-orgid': orgId } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`Zitadel ${path} returned ${response.status}`);
  return response.json() as Promise<unknown>;
}
async function list(path: string, queries: unknown[] = []) {
  return z.object({ result: z.array(object).default([]) }).parse(await api(path, { queries })).result;
}
const exactName = (value: string) => [{ nameQuery: { name: value, method: 'TEXT_QUERY_METHOD_EQUALS' } }];
async function secondarySetup() {
  // Only this existing app in this pinned organisation may change. Never run owner provisioning here.
  orgId = '393311211338337681';
  const projectId = '393311211539664273', appId = '393311211707436433';
  const org = z.object({ org: object }).parse(await api('/management/v1/orgs/me')).org;
  assert(org.id === orgId && org.name === name, 'Refusing another organisation');
  const path = `/management/v1/projects/${projectId}/apps/${appId}`;
  const app = z.object({ app: z.object({ name: z.literal('OpenCrane 2 Dev Web'),
    oidcConfig: z.object({ clientId: z.literal('393311211707501969'), redirectUris: z.array(z.string()),
      postLogoutRedirectUris: z.array(z.string()), devMode: z.boolean().optional() }).passthrough(),
    details: z.object({ resourceOwner: z.literal('393311211338337681') }) }) }).parse(await api(path)).app;
  const origins = ['http://127.0.0.1:25106', 'http://127.0.0.1:25206'];
  const config = app.oidcConfig;
  const redirectUris = [...new Set([...config.redirectUris, ...origins.map(origin => `${origin}/auth/callback`)])];
  const postLogoutRedirectUris = [...new Set([...config.postLogoutRedirectUris, ...origins.map(origin => `${origin}/`)])];
  if (!config.devMode || redirectUris.length !== config.redirectUris.length || postLogoutRedirectUris.length !== config.postLogoutRedirectUris.length) {
    // Preserve all existing mutable OIDC settings; omit response-only fields.
    const { clientId: _clientId, complianceProblems: _problems, isCompliance: _compliance, ...settings } = config;
    await api(`${path}/oidc_config`, { ...settings, redirectUris, postLogoutRedirectUris, devMode: true }, 'PUT');
  }
  const ownerDirectory = `${homedir()}/.config/opencrane/dev-stack`;
  const setup = z.object({ issuer: z.literal(issuer), orgId: z.literal('393311211338337681'),
    clientId: z.literal('393311211707501969'), users: z.record(z.string(), z.object({ id: z.string(), login: z.string(), passwordFile: z.string() })) })
    .passthrough().parse(JSON.parse(await readFile(`${ownerDirectory}/zitadel.json`, 'utf8')));
  for (const role of ['owner', 'member']) {
    await save(`zitadel-${role}-password`, await readFile(`${ownerDirectory}/zitadel-${role}-password`, 'utf8'));
    setup.users[role]!.passwordFile = `${directory}/zitadel-${role}-password`;
  }
  await save('zitadel-client-secret', await readFile(`${ownerDirectory}/zitadel-client-secret`, 'utf8'));
  await save('zitadel.json', JSON.stringify({ ...setup, origin: localOrigin }));
  console.log('Secondary redirects ready in OpenCrane 2 Dev; shared app and identities retained');
}
try {
  await prepareDirectory();
  if (secondary) { await secondarySetup(); process.exit(0); }
  const pinned = z.object({ orgId: z.string().optional(), extraIdentities: z.array(identity).length(1) })
    .parse(JSON.parse(await readFile(`${root}/infra/dev-stack/zitadel.json`, 'utf8')));
  const externalOwner = pinned.extraIdentities[0]!;
  assert(externalOwner.issuer === issuer, 'External owner issuer must match this Zitadel instance');
  const orgs = await list('/admin/v1/orgs/_search', exactName(name));
  assert(orgs.length <= 1 && orgs.every((org) => org.name === name), 'Organisation search must be exact');
  if (pinned.orgId) assert(orgs[0]?.id === pinned.orgId, 'Recorded organisation missing or changed; refusing to create another');
  orgId = orgs[0]?.id ?? z.object({ id: z.string() }).parse(await api('/management/v1/orgs', { name })).id;
  const org = z.object({ org: object }).parse(await api('/management/v1/orgs/me')).org;
  assert(org.id === orgId && org.name === name, 'Refusing another organisation');
  const projects = await list('/management/v1/projects/_search', exactName(name));
  assert(projects.length <= 1);
  const projectId = projects[0]?.id ?? z.object({ id: z.string() }).parse(await api('/management/v1/projects', { name })).id;
  const apps = await list(`/management/v1/projects/${projectId}/apps/_search`, exactName('OpenCrane 2 Dev Web'));
  assert(apps.length <= 1);
  let appId = apps[0]?.id;
  let clientId: string;
  if (appId) {
    const result = z.object({ app: z.object({ oidcConfig: z.object({ clientId: z.string() }) }) })
      .parse(await api(`/management/v1/projects/${projectId}/apps/${appId}`));
    clientId = result.app.oidcConfig.clientId;
    assert(await exists(`${directory}/zitadel-client-secret`), 'Existing app secret missing; do not create another app');
  } else {
    const app = z.object({ appId: z.string(), clientId: z.string(), clientSecret: z.string() }).parse(
      await api(`/management/v1/projects/${projectId}/apps/oidc`, { name: 'OpenCrane 2 Dev Web',
        redirectUris: [`${origin}/auth/callback`], postLogoutRedirectUris: [`${origin}/`],
        responseTypes: ['OIDC_RESPONSE_TYPE_CODE'], grantTypes: ['OIDC_GRANT_TYPE_AUTHORIZATION_CODE'],
        appType: 'OIDC_APP_TYPE_WEB', authMethodType: 'OIDC_AUTH_METHOD_TYPE_POST', version: 'OIDC_VERSION_1_0',
        idTokenUserinfoAssertion: true }));
    await save('zitadel-client-secret', app.clientSecret);
    appId = app.appId;
    clientId = app.clientId;
  }
  const users: Record<string, { id: string; login: string; passwordFile: string }> = {};
  for (const role of ['owner', 'member']) {
    const userName = `opencrane2-dev-${role}`;
    const passwordFile = `${directory}/zitadel-${role}-password`;
    const found = await list('/management/v1/users/_search', [{ userNameQuery: { userName, method: 'TEXT_QUERY_METHOD_EQUALS' } }]);
    assert(found.length <= 1);
    let userId = found[0]?.id;
    if (!userId) {
      // Save before creating: an interrupted request can be recovered by exact username.
      if (!(await exists(passwordFile))) await save(`zitadel-${role}-password`, `Oc2!${randomBytes(24).toString('base64url')}a9`);
      const result = z.object({ userId: z.string() }).parse(await api('/management/v1/users/human/_import', {
        userName, profile: { firstName: 'OpenCrane', lastName: role === 'owner' ? 'Owner' : 'Member', preferredLanguage: 'en' },
        email: { email: `${userName}@example.test`, isEmailVerified: true },
        password: await readFile(passwordFile, 'utf8'), passwordChangeRequired: false,
      }));
      userId = result.userId;
    }
    assert(await exists(passwordFile), 'Existing user password missing');
    const user = z.object({ user: object }).parse(await api(`/management/v1/users/${userId}`)).user;
    assert(user.preferredLoginName);
    users[role] = { id: userId, login: user.preferredLoginName, passwordFile };
  }
  const ownerGrants = z.object({ result: z.array(userGrant).default([]) }).parse(await api('/management/v1/users/grants/_search', {
    query: { limit: 100 }, queries: [
      { userIdQuery: { userId: externalOwner.subject } },
      { projectIdQuery: { projectId } },
    ],
  })).result;
  assert(ownerGrants.length <= 1, 'External owner has duplicate grants for this project');
  let ownerGrantId = ownerGrants[0]?.id;
  if (!ownerGrantId) {
    ownerGrantId = z.object({ userGrantId: z.string() }).parse(await api(
      `/management/v1/users/${externalOwner.subject}/grants`, { projectId, roleKeys: [] },
    )).userGrantId;
  } else {
    const grant = ownerGrants[0]!;
    assert(grant.userId === externalOwner.subject && grant.projectId === projectId
      && grant.details.resourceOwner === orgId && grant.roleKeys.length === 0,
    'External owner grant differs from the expected project-only access');
    assert(grant.state === 'USER_GRANT_STATE_ACTIVE', 'External owner grant is not active');
  }
  const members = z.object({ result: z.array(z.object({ userId: z.string(), roles: z.array(z.string()) })).default([]) })
    .parse(await api('/management/v1/orgs/me/members/_search', { query: { limit: 100 } })).result;
  const owner = members.find((member) => member.userId === users['owner']!.id);
  if (!owner) await api('/management/v1/orgs/me/members', { userId: users['owner']!.id, roles: ['ORG_OWNER'] });
  else assert(owner.roles.includes('ORG_OWNER'), 'Existing test owner has unexpected roles');
  await save('zitadel.json', JSON.stringify({ issuer, orgId, projectId, appId, clientId, origin, users,
    extraIdentities: pinned.extraIdentities, externalOwnerGrantId: ownerGrantId }, null, 2));
  console.log(JSON.stringify({ name, orgId, projectId, appId, clientId, users,
    externalOwner: { subject: externalOwner.subject, userGrantId: ownerGrantId } }, null, 2));
} catch (error) {
  // Only our fixed diagnostics are public; never dump a provider body or request.
  console.error(error instanceof assert.AssertionError ? error.message : 'Zitadel setup failed; no provider response was logged');
  process.exitCode = 1;
}
