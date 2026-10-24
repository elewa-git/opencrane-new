import { createHash } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
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

async function join(memberId: string) {
  const role = memberId === 'admin' ? 'admin' : 'member';
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
  for (const member of ['alice', 'bob', 'admin']) {
    await join(member);
  }
  function memberId(_silo: string, _issuer: string, subject: string) {
    return Promise.resolve(subject === 'unmapped' ? undefined : subject);
  }
  const memberReads = { silo: 'test', store: nats.store, binding,
    db: pgDb(storage.queue), feed: { memberId } };
  app = buildServer(config, { memberReads });
}
beforeAll(initialise, 120_000);
async function close() {
  await app?.close();
  await storage?.close();
  await fga?.close();
  await nats?.close();
}
afterAll(close);
function headers(memberId = 'alice', orgId = 'org-test') {
  const now = Math.floor(Date.now() / 1000);
  const session = { sub: memberId, orgId, roles: ['owner'], authTime: now, exp: now + 60 };
  return { cookie: `${config.cookieName}=${encodeSession(config, session)}` };
}
async function saved() {
  counter += 1;
  const serverId = `server${counter}`;
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
  const url = `/api/my/tools/${serverId}/profiles/${profileId}`;
  return { serverId, profileId, subject, event, data, revision, url };
}
async function readsOwnSavedState() {
  const fixture = await saved();
  const append = vi.spyOn(nats.store, 'append');
  const read = vi.spyOn(nats.store, 'readStream');
  try {
    const response = await app.inject({ url: fixture.url, headers: headers() });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual({ serverId: fixture.serverId, profileId: fixture.profileId,
      profileRevision: fixture.revision, status: 'saved_unverified', generation: 1,
      adminBlocked: false, serverAvailable: true, callsAvailable: false });
    expect(response.body).not.toContain(privateCanary);
    expect(response.body).not.toMatch(/secret|uid|endpoint|label|Connected|verifiedIdentity/u);
    expect(append).not.toHaveBeenCalled();
    expect(read.mock.calls.map(readSubject)).toEqual([
      fixture.subject, `connection-control-alice-${fixture.serverId}`,
      `mcp-${fixture.serverId}`, 'member-alice', 'ownership-test',
    ]);
  } finally {
    vi.restoreAllMocks();
  }
}
function readSubject(call: unknown[]) {
  return call[0];
}
it('lets Alice read only safe saved metadata without a tool grant or any effects', readsOwnSavedState);
