import { OpenFgaClient } from '@openfga/sdk';
import { setTimeout as delay } from 'node:timers/promises';
import * as custody from '../../../libs/models/src/connection-custody.ts';
import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { encodeSession } from '@opencrane/auth';
import { createStore, memberAuthorisation } from '@opencrane/authz';
import { databases, openfga } from '@opencrane/authz/testing';
import { natsFixture } from '@opencrane/event-store/testing';
import { catalogueDigest } from '@opencrane/events/mcp-catalogue';
import { envelope } from '@opencrane/models';
import { pgDb } from '@opencrane/projections';
import { buildServer } from '../src/server.ts';
import { testAuthConfig } from './support/test-auth-config.ts';

const config = testAuthConfig({ expectedOrgId: 'org-test' });
const privateCanary = 'private-custody-canary';
let nats: Awaited<ReturnType<typeof natsFixture>>;
let fga: Awaited<ReturnType<typeof openfga>>;
let storage: Awaited<ReturnType<typeof databases>>;
let app: ReturnType<typeof buildServer>;
let binding: Awaited<ReturnType<typeof createStore>>;
let counter = 0;
const logs: string[] = [];
function write(line: string) {
  logs.push(line);
}
afterEach(vi.restoreAllMocks);

async function join(memberId: string) {
  let role = 'member';
  if (memberId === 'admin' || memberId === 'owner') {
    role = memberId;
  }
  const data = { memberId, role, email: `${memberId}@example.test`, displayName: memberId };
  const event = envelope('test', `member-${memberId}`, 'member.joined', data);
  const expectedSequence = await nats.store.head(event.subject);
  await nats.store.append({ event, expectedSequence });
  await memberAuthorisation(binding).handler.handle(event, pgDb(storage.queue));
}
async function initialise() {
  nats = await natsFixture();
  fga = await openfga();
  storage = await databases();
  binding = await createStore(fga.apiUrl, 'test');
  for (const member of ['alice', 'bob', 'admin', 'owner']) {
    await join(member);
  }
  function memberId(_silo: string, _issuer: string, subject: string) {
    return Promise.resolve(subject === 'unmapped' ? undefined : subject);
  }
  const memberReads = { silo: 'test', store: nats.store, binding,
    db: pgDb(storage.queue), feed: { memberId } };
  vi.stubEnv('LOG_LEVEL', 'info');
  app = buildServer(config, { memberReads, logDestination: { write } });
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
function headers(memberId = 'admin', orgId = 'org-test') {
  const now = Math.floor(Date.now() / 1000);
  const session = { sub: memberId, orgId, roles: ['owner'], authTime: now, exp: now + 60 };
  return { cookie: `${config.cookieName}=${encodeSession(config, session)}` };
}
async function saved(serverId = `server${counter + 1}`) {
  counter += 1;
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
  const event = envelope('test', subject, 'connection.created', data, data.activation.operationId);
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
  const url = `/api/integrations/${serverId}/members/alice/profiles/${profileId}`;
  return { serverId, profileId, subject, event, data, revision, url };
}
function privateOutput(response: { body: string; headers: Record<string, unknown> }) {
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.body).not.toContain(privateCanary);
  expect(logs.join('\n')).not.toContain(privateCanary);
}
async function readsSafeMetadata(actor: string) {
  const fixture = await saved();
  const append = vi.spyOn(nats.store, 'append');
  const head = vi.spyOn(nats.store, 'head');
  const noCustody = vi.spyOn(custody, 'connectionCustody');
  const provider = vi.spyOn(globalThis, 'fetch');
  const check = vi.spyOn(OpenFgaClient.prototype, 'check');
  const response = await app.inject({ url: fixture.url, headers: headers(actor) });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ serverId: fixture.serverId, profileId: fixture.profileId,
    profileRevision: fixture.revision, controlRevision: 0, status: 'saved_unverified',
    generation: 1, adminBlocked: false, serverAvailable: true, callsAvailable: false });
  privateOutput(response);
  expect(check).toHaveBeenCalledTimes(1);
  expect(check.mock.calls[0]?.[0].relation).toBe('admin');
  expect(head).not.toHaveBeenCalled();
  expect(append).not.toHaveBeenCalled();
  expect(noCustody).not.toHaveBeenCalled();
  for (const [request] of provider.mock.calls) {
    let address = String(request);
    if (request instanceof Request) {
      address = request.url;
    }
    expect(address.startsWith(fga.apiUrl)).toBe(true);
  }
}
it.each(['admin', 'owner'])('lets current %s inspect safe metadata without effects', readsSafeMetadata);
