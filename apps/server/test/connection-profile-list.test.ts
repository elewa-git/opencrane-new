import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { encodeSession } from '@opencrane/auth';
import { createStore, memberAuthorisation } from '@opencrane/authz';
import { openfga } from '@opencrane/authz/testing';
import { natsFixture } from '@opencrane/event-store/testing';
import { catalogueDigest } from '@opencrane/events/mcp-catalogue';
import { envelope } from '@opencrane/models';
import { createLogger } from '@opencrane/observability';
import { ProjectionRunner, connectionProfiles } from '@opencrane/projections';
import { database } from '../../../libs/projections/test/database.ts';
import { buildServer } from '../src/server.ts';
import { testAuthConfig } from './support/test-auth-config.ts';

const config = testAuthConfig({ expectedOrgId: 'org-test' });
const logger = createLogger('connection-list-test', { level: 'silent' });
const privateCanary = 'private-profile-canary';
let nats: Awaited<ReturnType<typeof natsFixture>>;
let fga: Awaited<ReturnType<typeof openfga>>;
let storage: Awaited<ReturnType<typeof database>>;
let runner: ProjectionRunner;
let app: ReturnType<typeof buildServer>;

function memberId(_silo: string, _issuer: string, subject: string) {
  return Promise.resolve(subject);
}
async function setup() {
  storage = await database('pg');
  nats = await natsFixture();
  fga = await openfga();
  const binding = await createStore(fga.apiUrl, 'test');
  const db = storage.db;
  runner = new ProjectionRunner(db, nats.reader, logger);
  await runner.initialise(connectionProfiles);
  for (const member of ['alice', 'bob']) {
    const data = { memberId: member, role: 'member', email: `${member}@example.test`,
      displayName: member };
    const event = envelope('test', `member-${member}`, 'member.joined', data);
    await nats.seed([event]);
    await memberAuthorisation(binding).handler.handle(event, db);
  }
  const options = { silo: 'test', store: nats.store, binding, db,
    feed: { memberId } };
  app = buildServer(config, { memberReads: options });
}
beforeEach(setup, 120_000);
async function close() {
  await app?.close();
  await fga?.close();
  await nats?.close();
  await storage?.close();
}
afterEach(close);

function headers(member: string) {
  const now = Math.floor(Date.now() / 1000);
  const session = { sub: member, orgId: 'org-test', roles: [], authTime: now, exp: now + 60 };
  return { cookie: `${config.cookieName}=${encodeSession(config, session)}` };
}
async function server() {
  const serverId = 'shared';
  const locator = 'https://example.test/mcp';
  const digest = createHash('sha256').update(JSON.stringify(locator)).digest('hex');
  const registered = envelope('test', `mcp-${serverId}`, 'mcp.server_registered',
    { serverId, kind: 'remote', locator, registeredBy: 'alice' });
  const now = Date.now();
  const catalogue = { serverId, connectionId: 'installed', accountMode: 'personal',
    tools: [], toolCount: 0, schemaDigest: catalogueDigest([]),
    checkedAt: new Date(now).toISOString(), expiresAt: new Date(now + 300_000).toISOString() };
  const discovered = envelope('test', registered.subject, 'mcp.server_discovered', catalogue);
  await nats.seed([registered, discovered]);
  const policyRevision = await nats.store.head(registered.subject);
  const reviewed = envelope('test', registered.subject, 'mcp.server_reviewed',
    { serverId, connectionId: 'installed', accountMode: 'personal', tools: [],
      catalogueDigest: catalogue.schemaDigest, policyRevision, reviewedBy: 'alice' });
  reviewed.principal = { kind: 'human', id: 'alice' };
  const published = envelope('test', registered.subject, 'mcp.server_published',
    { serverId, publishedBy: 'alice' });
  await nats.seed([reviewed, published]);
  return digest;
}
async function profile(member: string, profileId: string, endpointDigest: string) {
  const subject = `connection-${member}-shared-${profileId}`;
  const data = { userId: member, serverId: 'shared', profile: profileId,
    secretRef: `secret:${privateCanary}`, activation: {
      connectionId: 'installed', ownerKind: 'personal', purpose: 'personal', generation: 1,
      uid: privateCanary, resourceVersion: privateCanary, endpointDigest,
      operationId: `save-${member}-${profileId}`, changedBy: member, expectedSequence: 0,
      appendUntil: Date.now() + 60_000, reason: 'bearer_create',
    } };
  const event = envelope('test', subject, 'connection.created', data, data.activation.operationId);
  event.principal = { kind: 'human', id: member };
  await nats.seed([event]);
}
async function list(member: string, query = '') {
  return app.inject({ url: `/api/my/tools/shared/profiles${query}`, headers: headers(member) });
}

it('shows each member only their own profiles on a shared server', async () => {
  const digest = await server();
  await profile('alice', 'mine', digest);
  await profile('bob', 'theirs', digest);
  await runner.run(connectionProfiles);
  const alice = await list('alice');
  expect(alice.statusCode).toBe(200);
  expect(alice.json().rows.map((row: { profileId: string }) => row.profileId)).toEqual(['mine']);
  expect(alice.body).not.toContain(privateCanary);
  const bob = await list('bob');
  expect(bob.json().rows.map((row: { profileId: string }) => row.profileId)).toEqual(['theirs']);
});

it('pages sixty profiles without duplicates or omissions', async () => {
  const digest = await server();
  for (let index = 0; index < 60; index += 1) {
    await profile('alice', `profile${index}`, digest);
  }
  await runner.run(connectionProfiles);
  const seen: string[] = [];
  let cursor: string | null = null;
  do {
    const query = cursor ? `?limit=20&cursor=${encodeURIComponent(cursor)}` : '?limit=20';
    const response = await list('alice', query);
    expect(response.statusCode).toBe(200);
    const page = response.json();
    expect(page.rows.length).toBeLessThanOrEqual(20);
    seen.push(...page.rows.map((row: { profileId: string }) => row.profileId));
    cursor = page.next;
  } while (cursor);
  expect(new Set(seen).size).toBe(60);
  expect(seen).toHaveLength(60);
});
