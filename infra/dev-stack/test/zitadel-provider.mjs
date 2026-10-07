// A provider boundary for the CLI tests. No request can reach the network.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';

const file = process.env.MOCK_ZITADEL_FILE;
const orgId = '393311211338337681';
const projectId = '393311211539664273';
globalThis.fetch = async (url, options) => {
  const state = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(options.headers['x-zitadel-orgid'], orgId);
  const path = new URL(url).pathname;
  const body = options.body ? JSON.parse(options.body) : undefined;
  const appBase = `/management/v1/projects/${projectId}/apps`;
  let result;
  if (path === '/management/v1/orgs/me') {
    result = { org: { id: orgId, name: 'OpenCrane 2 Dev' } };
  } else if (path === `/management/v1/projects/${projectId}`) {
    result = { project: { id: projectId, name: 'OpenCrane 2 Dev', details: { resourceOwner: orgId } } };
  } else if (path === `${appBase}/_search`) {
    const name = body.queries[0].nameQuery.name;
    result = { result: Object.values(state.apps).filter(app => app.name === name) };
  } else if (path === `${appBase}/oidc`) {
    const appId = 'ci-app';
    state.apps[appId] = { id: appId, name: body.name, details: { resourceOwner: orgId },
      oidcConfig: { ...body, clientId: 'ci-client' } };
    result = { appId, clientId: 'ci-client', clientSecret: 'fake-ci-secret' };
  } else if (path.startsWith(`${appBase}/`) && options.method === 'GET') {
    result = { app: state.apps[path.split('/').at(-1)] };
  } else if (path.endsWith('/oidc_config') && options.method === 'PUT') {
    assert.equal(state.updates ?? 0, 0, 'An unchanged owner app must not be updated again');
    const app = state.apps[path.split('/').at(-2)];
    assert.ok(!('clientId' in body || 'isCompliance' in body || 'complianceProblems' in body || 'allowedOrigins' in body));
    app.oidcConfig = { ...app.oidcConfig, ...body };
    state.updates = (state.updates ?? 0) + 1;
    result = {};
  } else if (path === '/management/v1/users/_search') {
    const userName = body.queries[0].userNameQuery.userName;
    result = { result: Object.values(state.users).filter(user => user.userName === userName) };
  } else if (path === '/management/v1/orgs/members/roles/_search') {
    result = { result: ['ORG_OWNER', 'ORG_OWNER_VIEWER', 'ORG_USER_MANAGER'] };
  } else if (path === '/management/v1/users/machine') {
    assert.match(body.userName, /^opencrane2-dev-ci-[12]-directory$/u);
    state.users[body.userName] = { id: body.userName, userName: body.userName,
      details: { resourceOwner: orgId }, machine: {} };
    result = { userId: body.userName };
  } else if (path === '/management/v1/orgs/me/members/_search') {
    result = { result: state.directoryRoles ? [{ userId: body.queries[0].userIdQuery.userId,
      roles: state.directoryRoles }] : [] };
  } else if (path === '/management/v1/orgs/me/members') {
    assert.deepEqual(body.roles, ['ORG_OWNER_VIEWER']);
    state.directoryRoles = body.roles;
    result = {};
  } else if (path.endsWith('/keys/_search')) {
    result = { result: state.directoryKey ? [{}] : [] };
  } else if (path.endsWith('/keys')) {
    state.directoryKey = true;
    result = { keyDetails: Buffer.from('fake-directory-private-key').toString('base64') };
  } else if (path === '/management/v1/users/human/_import') {
    const userId = body.userName;
    assert.match(userId, /^opencrane2-dev-ci-[12]-(owner|member|without-assistant|wrong-account)$/u);
    assert.ok(!state.users[userId], 'Existing users must be reused');
    state.users[userId] = { id: userId, userName: body.userName,
      preferredLoginName: body.userName, details: { resourceOwner: orgId }, password: body.password };
    result = { userId };
  } else if (path.startsWith('/management/v1/users/') && options.method === 'GET') {
    result = { user: state.users[path.split('/').at(-1)] };
  } else {
    throw new Error(`Unexpected provider operation: ${options.method} ${path}`);
  }
  await writeFile(file, JSON.stringify(state));
  return Response.json(result);
};
