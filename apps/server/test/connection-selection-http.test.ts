import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { encodeSession } from '@opencrane/auth';
import { createStore, grantStream, memberAuthorisation } from '@opencrane/authz';
import { databases, openfga } from '@opencrane/authz/testing';
import { catalogueDigest } from '@opencrane/events/mcp-catalogue';
import { envelope, history } from '@opencrane/models';
import { pgDb } from '@opencrane/projections';
import { buildServer } from '../src/server.ts';
import { testAuthConfig } from './support/test-auth-config.ts';
import { shortDuplicateWindowFixture, waitForDuplicateWindow }
  from './support/duplicate-window.ts';

const config = testAuthConfig({ expectedOrgId: 'org-test' });
const privateCanary = 'private-custody-canary';
const material = 'synthetic-bearer-value';
let nats: Awaited<ReturnType<typeof shortDuplicateWindowFixture>>;
let fga: Awaited<ReturnType<typeof openfga>>;
let storage: Awaited<ReturnType<typeof databases>>;
let app: ReturnType<typeof buildServer>;
let binding: Awaited<ReturnType<typeof createStore>>;
let counter = 0;
const logs: string[] = [];
function write(line: string) {
  logs.push(line);
}
const logDestination = { write };
function startApp(store = nats.store, silo = 'test') {
  function memberId(_silo: string, _issuer: string, subject: string) {
    return Promise.resolve(subject);
  }
  const memberReads = { silo, store, binding,
    db: pgDb(storage.queue), feed: { memberId } };
  return buildServer(config, { memberReads, logDestination });
}

async function join(memberId: string) {
  const role = memberId === 'admin' ? 'admin' : 'member';
  const data = { memberId, role, email: `${memberId}@example.test`, displayName: memberId };
  const event = envelope('test', `member-${memberId}`, 'member.joined', data);
  const expectedSequence = await nats.store.head(event.subject);
  await nats.store.append({ event, expectedSequence });
  await memberAuthorisation(binding).handler.handle(event, pgDb(storage.queue));
}
async function initialise() {
  nats = await shortDuplicateWindowFixture();
  fga = await openfga();
  storage = await databases();
  binding = await createStore(fga.apiUrl, 'test');
  for (const member of ['alice', 'bob', 'admin']) {
    await join(member);
  }
  vi.stubEnv('LOG_LEVEL', 'info');
  app = startApp();
}
beforeAll(initialise, 120_000);
async function close() {
  await app?.close();
  await storage?.close();
  await fga?.close();
  await nats?.close();
  vi.unstubAllEnvs();
}
afterAll(close);
function headers(memberId = 'alice', orgId = 'org-test') {
  const now = Math.floor(Date.now() / 1000);
  const session = { sub: memberId, orgId, roles: ['owner'], authTime: now, exp: now + 60 };
  return { origin: new URL(config.redirectUri).origin, cookie: `${config.cookieName}=${encodeSession(config, session)}` };
}
async function saved() {
  counter += 1;
  const serverId = `server${counter}`;
  const changeRef = `save${counter}`;
  const profileId = `profile${counter}`;
  const subject = `connection-alice-${serverId}-${profileId}`;
  const locator = 'https://example.test/mcp';
  const hash = createHash('sha256');
  hash.update(JSON.stringify(locator));
  const data = { userId: 'alice', serverId, profile: profileId,
    secretRef: `secret:${privateCanary}`, activation: {
      connectionId: 'installed', ownerKind: 'personal', purpose: 'personal', generation: 1,
      uid: privateCanary, resourceVersion: privateCanary, endpointDigest: hash.digest('hex'),
      operationId: `save${counter}`, changedBy: 'alice', expectedSequence: 0,
      appendUntil: Date.now() + 60_000, reason: 'bearer_create',
    } };
  const operationHash = createHash('sha256');
  operationHash.update(JSON.stringify(['test', subject, changeRef]));
  data.activation.operationId = operationHash.digest('hex');
  const event = envelope('test', subject, 'connection.created', data, data.activation.operationId);
  event.source = 'opencrane-server';
  event.commandId = changeRef;
  event.principal = { kind: 'human', id: 'alice' };
  await nats.seed([event]);
  const revision = await nats.store.head(subject);
  const registered = envelope('test', `mcp-${serverId}`, 'mcp.server_registered',
    { serverId, kind: 'remote', locator, registeredBy: 'admin' });
  const now = Date.now();
  const catalogue = { serverId, connectionId: 'installed', accountMode: 'personal',
    tools: [], toolCount: 0, schemaDigest: catalogueDigest([]),
    checkedAt: new Date(now).toISOString(), expiresAt: new Date(now + 300_000).toISOString() };
  const discovered = envelope('test', registered.subject, 'mcp.server_discovered', catalogue);
  await nats.seed([registered, discovered]);
  const policyRevision = await nats.store.head(registered.subject);
  const reviewed = envelope('test', registered.subject, 'mcp.server_reviewed', {
    serverId, connectionId: 'installed', accountMode: 'personal', tools: [],
    catalogueDigest: catalogue.schemaDigest, policyRevision, reviewedBy: 'admin',
  });
  reviewed.principal = { kind: 'human', id: 'admin' };
  const published = envelope('test', registered.subject, 'mcp.server_published',
    { serverId, publishedBy: 'admin' });
  await nats.seed([reviewed, published]);
  const grant = envelope('test', grantStream('mcp_server', serverId), 'grant.given', {
    resourceType: 'mcp_server', resourceId: serverId, granteeKind: 'member',
    granteeId: 'alice', grantedBy: 'admin',
  });
  await nats.seed([grant]);
  await memberAuthorisation(binding).handler.handle(grant, pgDb(storage.queue));
  const url = `/api/my/tools/${serverId}/selection`;
  return { serverId, profileId, subject, revision, url, changeRef };
}

function selection(fixture: Awaited<ReturnType<typeof saved>>) {
  return { action: 'select', connectionId: 'installed', changeRef: 'choice', expectedSequence: 0,
    profileId: fixture.profileId, profileRevision: fixture.revision };
}
async function post(url: string, payload: object | string, requestHeaders = headers()) {
  const response = await app.inject({ method: 'POST', url, payload, headers: requestHeaders });
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.body).not.toContain(privateCanary);
  expect(response.body).not.toContain(material);
  expect(logs.join('\n')).not.toContain(privateCanary);
  expect(logs.join('\n')).not.toContain(material);
  return response;
}
async function savesOnce() {
  const fixture = await saved();
  const input = selection(fixture);
  const response = await post(fixture.url, input);
  expect(response.statusCode).toBe(200);
  const selected = response.json();
  expect(selected).toEqual({ status: 'selected', sequence: expect.any(Number), changeRef: 'choice' });
  const clear = { action: 'clear', connectionId: 'installed', changeRef: 'clear',
    expectedSequence: selected.sequence };
  const cleared = await post(fixture.url, clear);
  expect(cleared.statusCode).toBe(200);
  expect(cleared.json()).toEqual({ status: 'cleared', sequence: expect.any(Number), changeRef: 'clear' });
  const position = await nats.store.head();
  expect((await post(fixture.url, input)).json()).toEqual(selected);
  expect((await post(fixture.url, clear)).json()).toEqual(cleared.json());
  expect(await nats.store.head()).toBe(position);
  const rows = await history(nats.store, `connection-selection-alice-${fixture.serverId}`, 'test');
  expect(rows).toHaveLength(2);
  expect(JSON.stringify(rows)).not.toContain(privateCanary);
}
it('saves an explicit select and clear once and returns their original receipts', savesOnce);
