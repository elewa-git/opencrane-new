import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { encodeSession } from '@opencrane/auth';
import { createStore, memberAuthorisation } from '@opencrane/authz';
import { openfga } from '@opencrane/authz/testing';
import { natsFixture } from '@opencrane/event-store/testing';
import { catalogueDigest } from '@opencrane/events/mcp-catalogue';
import { envelope } from '@opencrane/models';
import { createLogger } from '@opencrane/observability';
import { ProjectionRunner, connectionProfiles } from '@opencrane/projections';
import { database } from '../../../libs/projections/test/database.ts';
import { oauthSelectionFixture } from '../../../libs/models/test/support/oauth-selection.ts';
import { buildServer } from '../src/server.ts';
import { testAuthConfig } from './support/test-auth-config.ts';

const config = testAuthConfig({ expectedOrgId: 'org-test' });
const logger = createLogger('connection-list-test', { level: 'silent' });
const privateCanary = 'private-profile-canary';
type Row = { profileId: string; status: string; generation: number | null;
  callsAvailable: false; adminBlocked: boolean; selected: boolean };
type Page = { rows: Row[]; next: string | null };
function profileId(row: Row) { return row.profileId; }
function findProfile(rows: Row[], id: string) {
  for (const row of rows) {
    if (row.profileId === id) return row;
  }
  return undefined;
}
let nats: Awaited<ReturnType<typeof natsFixture>>;
let fga: Awaited<ReturnType<typeof openfga>>;
let storage: Awaited<ReturnType<typeof database>>;
let runner: ProjectionRunner;
let app: ReturnType<typeof buildServer>;
let binding: Awaited<ReturnType<typeof createStore>>;

function memberId(_silo: string, _issuer: string, subject: string) {
  return Promise.resolve(subject);
}
async function setup() {
  storage = await database('pg');
  nats = await natsFixture();
  fga = await openfga();
  binding = await createStore(fga.apiUrl, 'test');
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
  vi.restoreAllMocks();
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
  expect(alice.json<Page>().rows.map(profileId)).toEqual(['mine']);
  expect(alice.body).not.toContain(privateCanary);
  const bob = await list('bob');
  expect(bob.json<Page>().rows.map(profileId)).toEqual(['theirs']);
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
    const page = response.json<Page>();
    expect(page.rows.length).toBeLessThanOrEqual(20);
    seen.push(...page.rows.map(profileId));
    cursor = page.next;
  } while (cursor);
  expect(new Set(seen).size).toBe(60);
  expect(seen).toHaveLength(60);
});

it('keeps revoked and disabled profiles visible without private data', async () => {
  const digest = await server();
  await profile('alice', 'revoked', digest);
  await profile('alice', 'blocked', digest);
  const revision = await nats.store.head('connection-alice-shared-revoked');
  const revoked = envelope('test', 'connection-alice-shared-revoked', 'connection.revoked',
    { userId: 'alice', serverId: 'shared', profile: 'revoked', revokedBy: 'alice',
      reason: 'owner_requested', expectedSequence: revision });
  const disabled = envelope('test', 'connection-control-alice-shared', 'connection.disabled',
    { userId: 'alice', serverId: 'shared', profile: 'blocked', disabledBy: 'bob',
      reason: 'admin_disabled', expectedSequence: 0 });
  await nats.seed([revoked, disabled]);
  await runner.run(connectionProfiles);
  const response = await list('alice');
  expect(response.statusCode).toBe(200);
  const rows = response.json<Page>().rows;
  function revokedRow(row: Row) { return row.profileId === 'revoked'; }
  function blockedRow(row: Row) { return row.profileId === 'blocked'; }
  expect(rows.find(revokedRow))
    .toMatchObject({ status: 'unavailable', generation: null, callsAvailable: false });
  expect(rows.find(blockedRow))
    .toMatchObject({ adminBlocked: true, callsAvailable: false });
  expect(response.body).not.toMatch(/private-profile-canary|secretRef|uid|resourceVersion/u);
});

it('lists saved, revoked and disabled bearer and OAuth profiles without private data', async () => {
  const digest = await server();
  for (const state of ['saved', 'revoked', 'disabled']) {
    await profile('alice', `bearer-${state}`, digest);
    await oauthSelectionFixture(nats, 'alice', 'shared', `oauth-${state}`);
  }
  for (const kind of ['bearer', 'oauth']) {
    const revokedSubject = `connection-alice-shared-${kind}-revoked`;
    const revision = await nats.store.head(revokedSubject);
    const revoked = envelope('test', revokedSubject, 'connection.revoked',
      { userId: 'alice', serverId: 'shared', profile: `${kind}-revoked`,
        revokedBy: 'alice', reason: 'owner_requested', expectedSequence: revision });
    await nats.seed([revoked]);
  }
  await runner.run(connectionProfiles);

  const beforeBlock = await list('alice');
  expect(beforeBlock.statusCode).toBe(200);
  const rows = beforeBlock.json<Page>().rows;
  expect(rows).toHaveLength(6);
  expect(findProfile(rows, 'bearer-saved')).toMatchObject({
    status: 'saved_unverified', generation: 1, adminBlocked: false, callsAvailable: false,
  });
  expect(findProfile(rows, 'oauth-saved')).toMatchObject({
    status: 'unavailable', generation: 1, adminBlocked: false, callsAvailable: false,
  });
  for (const kind of ['bearer', 'oauth']) {
    expect(findProfile(rows, `${kind}-revoked`)).toMatchObject({
      status: 'unavailable', generation: null, adminBlocked: false, callsAvailable: false,
    });
  }
  expect(beforeBlock.body).not.toMatch(
    /private-profile-canary|secret:synthetic|secretRef|uid|resourceVersion|account|accessToken/u);

  for (const kind of ['bearer', 'oauth']) {
    const controlSubject = 'connection-control-alice-shared';
    const revision = await nats.store.head(controlSubject);
    const disabled = envelope('test', controlSubject, 'connection.disabled',
      { userId: 'alice', serverId: 'shared', profile: `${kind}-disabled`,
        disabledBy: 'bob', reason: 'admin_disabled', expectedSequence: revision });
    await nats.seed([disabled]);
  }
  await runner.run(connectionProfiles);
  const afterBlock = await list('alice');
  expect(afterBlock.statusCode).toBe(200);
  const blockedRows = afterBlock.json<Page>().rows;
  expect(blockedRows).toHaveLength(6);
  expect(findProfile(blockedRows, 'bearer-disabled')).toMatchObject({
    status: 'saved_unverified', generation: 1, adminBlocked: true, callsAvailable: false,
  });
  expect(findProfile(blockedRows, 'oauth-disabled')).toMatchObject({
    status: 'unavailable', generation: 1, adminBlocked: true, callsAvailable: false,
  });
  expect(afterBlock.body).not.toMatch(
    /private-profile-canary|secret:synthetic|secretRef|uid|resourceVersion|account|accessToken/u);
});

it('marks only the member’s explicit saved choice', async () => {
  const digest = await server();
  await profile('alice', 'chosen', digest);
  await profile('alice', 'other', digest);
  const revision = await nats.store.head('connection-alice-shared-chosen');
  const subject = 'connection-selection-alice-shared';
  const changeRef = 'choose-one';
  const id = createHash('sha256').update(JSON.stringify(['test', subject, changeRef]))
    .digest('hex');
  const data = { userId: 'alice', serverId: 'shared', connectionId: 'installed',
    expectedSequence: 0, action: 'select', profileId: 'chosen', profileRevision: revision };
  const choice = envelope('test', subject, 'connection.selected', data, id);
  choice.commandId = changeRef;
  choice.source = 'opencrane-server';
  choice.principal = { kind: 'human', id: 'alice' };
  await nats.seed([choice]);
  await runner.run(connectionProfiles);
  const response = await list('alice');
  expect(response.statusCode).toBe(200);
  const rows = response.json<Page>().rows;
  function chosen(row: Row) { return row.profileId === 'chosen'; }
  function other(row: Row) { return row.profileId === 'other'; }
  expect(rows.find(chosen)?.selected).toBe(true);
  expect(rows.find(other)?.selected).toBe(false);
});

it('rejects cursor changes in filters, member and projection generation', async () => {
  const digest = await server();
  await profile('alice', 'one', digest);
  await profile('alice', 'two', digest);
  await runner.run(connectionProfiles);
  const first = await list('alice', '?limit=1');
  const cursor = encodeURIComponent(first.json<Page>().next!);
  expect((await list('alice', `?limit=2&cursor=${cursor}`)).statusCode).toBe(409);
  expect((await list('alice', `?limit=1&status=saved&cursor=${cursor}`)).statusCode).toBe(409);
  expect((await list('bob', `?limit=1&cursor=${cursor}`)).statusCode).toBe(409);
  await runner.rebuild(connectionProfiles);
  expect((await list('alice', `?limit=1&cursor=${cursor}`)).statusCode).toBe(409);
});

it('refuses removed members even when a page is empty or profile history fails', async () => {
  const digest = await server();
  await profile('alice', 'mine', digest);
  await runner.run(connectionProfiles);
  const removed = envelope('test', 'member-alice', 'member.removed',
    { memberId: 'alice', removedBy: 'bob' });
  await nats.seed([removed]);
  expect((await list('alice')).statusCode).toBe(403);
  expect((await app.inject({ url: '/api/my/tools/absent/profiles',
    headers: headers('alice') })).statusCode).toBe(403);
});

it('returns restart when a profile changes during loading', async () => {
  const digest = await server();
  await profile('alice', 'mine', digest);
  await runner.run(connectionProfiles);
  const original = nats.store.readStream.bind(nats.store);
  let changed = false;
  async function* changing(subject: string, from?: number, deadline?: number) {
    for await (const row of original(subject, from, deadline)) yield row;
    if (subject === 'connection-alice-shared-mine' && !changed) {
      changed = true;
      const revision = await nats.store.head(subject);
      const revoked = envelope('test', subject, 'connection.revoked',
        { userId: 'alice', serverId: 'shared', profile: 'mine', revokedBy: 'alice',
          reason: 'owner_requested', expectedSequence: revision });
      await nats.seed([revoked]);
    }
  }
  vi.spyOn(nats.store, 'readStream').mockImplementation(changing);
  const response = await list('alice');
  expect(response.statusCode).toBe(409);
  expect(response.json()).toEqual({ status: 'restart' });
});

it('loads slow history before checking current access', async () => {
  const digest = await server();
  await profile('alice', 'slow', digest);
  await runner.run(connectionProfiles);
  const original = nats.store.readStream.bind(nats.store);
  function wait(resolve: () => void) { setTimeout(resolve, 2_100); }
  async function* slow(subject: string, from?: number, deadline?: number) {
    if (subject === 'connection-alice-shared-slow') {
      expect(deadline! - performance.now()).toBeGreaterThan(2_000);
      await new Promise<void>(wait);
    }
    yield* original(subject, from, deadline);
  }
  vi.spyOn(nats.store, 'readStream').mockImplementation(slow);
  const response = await list('alice');
  expect(response.statusCode).toBe(200);
});

it('hides counts when the permission service is unavailable', async () => {
  const digest = await server();
  await profile('alice', 'mine', digest);
  await runner.run(connectionProfiles);
  binding.apiUrl = 'http://127.0.0.1:1';
  const response = await list('alice');
  expect(response.statusCode).toBe(503);
  expect(response.json()).toEqual({ status: 'unavailable' });
  expect(response.body).not.toContain('mine');
});

it('rebuilds the same safe list without saving another event', async () => {
  const digest = await server();
  await profile('alice', 'mine', digest);
  await runner.run(connectionProfiles);
  const first = await list('alice');
  const append = vi.spyOn(nats.store, 'append');
  await runner.rebuild(connectionProfiles);
  const replayed = await list('alice');
  expect(replayed.statusCode).toBe(200);
  expect(replayed.json<Page>().rows).toEqual(first.json<Page>().rows);
  expect(append).not.toHaveBeenCalled();
});
