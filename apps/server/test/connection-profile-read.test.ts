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

async function refusesOtherPeople() {
  const fixture = await saved();
  const originalRead = nats.store.readStream.bind(nats.store);
  function unreadableForeign(subject: string, from?: number, deadline?: number) {
    if (subject === fixture.subject) {
      throw new Error(privateCanary);
    }
    return originalRead(subject, from, deadline);
  }
  const read = vi.spyOn(nats.store, 'readStream').mockImplementation(unreadableForeign);
  try {
    for (const member of ['bob', 'admin']) {
      for (const url of [fixture.url, `${fixture.url}-missing`]) {
        const response = await app.inject({ url, headers: headers(member) });
        expect(response.statusCode).toBe(404);
        expect(response.json()).toEqual({ status: 'unknown' });
        expect(response.headers['cache-control']).toBe('no-store');
      }
    }
    expect(read.mock.calls.map(readSubject)).not.toContain(fixture.subject);
  } finally {
    vi.restoreAllMocks();
  }
}
it('keeps Alice’s existing, missing and unreadable profiles private from Bob and admins',
  refusesOtherPeople);

async function refusesExtraInput() {
  const fixture = await saved();
  const cases = [
    { url: fixture.url, headers: {}, code: 401 },
    { url: fixture.url, headers: headers('alice', 'foreign'), code: 403 },
    { url: fixture.url, headers: headers('unmapped'), code: 403 },
  ];
  for (const key of ['ownerId', 'userId', 'siloId', 'extra']) {
    cases.push({ url: `${fixture.url}?${key}=alice`, headers: headers('bob'), code: 400 });
  }
  for (const request of cases) {
    const response = await app.inject(request);
    expect(response.statusCode).toBe(request.code);
    expect(response.json()).toEqual({ status: 'refused' });
    expect(response.headers['cache-control']).toBe('no-store');
  }
  const response = await app.inject({ method: 'GET', url: fixture.url,
    headers: { ...headers(), 'content-type': 'application/json' }, payload: { ownerId: 'alice' } });
  expect(response.statusCode).toBe(400);
  expect(response.headers['cache-control']).toBe('no-store');
}
it('refuses foreign sessions, owner spoofing and extra input', refusesExtraInput);

async function removalWins(failed: boolean) {
  let removed: ReturnType<typeof envelope> | undefined;
  const fixture = await saved();
  const originalRead = nats.store.readStream.bind(nats.store);
  async function* removeDuringLoad(subject: string, from?: number, deadline?: number) {
    for await (const row of originalRead(subject, from, deadline)) {
      yield row;
    }
    if (subject === fixture.subject) {
      const event = envelope('test', 'member-alice', 'member.removed',
        { memberId: 'alice', removedBy: 'admin' });
      const expectedSequence = await nats.store.head(event.subject);
      await nats.store.append({ event, expectedSequence });
      removed = event;
      if (failed) {
        throw new Error(privateCanary);
      }
    }
  }
  vi.spyOn(nats.store, 'readStream').mockImplementation(removeDuringLoad);
  try {
    const response = await app.inject({ url: fixture.url, headers: headers() });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ status: 'refused' });
    expect(response.headers['cache-control']).toBe('no-store');
    const missing = await app.inject({ url: `${fixture.url}-missing`, headers: headers() });
    expect(missing.statusCode).toBe(403);
    expect(missing.json()).toEqual({ status: 'refused' });
  } finally {
    vi.restoreAllMocks();
    if (removed) {
      await memberAuthorisation(binding).handler.handle(removed, pgDb(storage.queue));
    }
    await join('alice');
  }
}
it.each([false, true])('removal during loading wins over record errors (failed=%s)', removalWins);

async function slowRead() {
  const fixture = await saved();
  const originalRead = nats.store.readStream.bind(nats.store);
  const subjects: string[] = [];
  async function* delayed(subject: string, from?: number, deadline?: number) {
    subjects.push(subject);
    if (subject === fixture.subject) {
      expect(deadline! - performance.now()).toBeGreaterThan(2_000);
      await new Promise(wait);
      const event = envelope('test', 'conversation-busy', 'conversation.closed',
        { conversationId: 'busy', closedBy: 'alice' });
      await nats.seed([event]);
    }
    yield* originalRead(subject, from, deadline);
  }
  function wait(resolve: () => void) {
    setTimeout(resolve, 2_100);
  }
  vi.spyOn(nats.store, 'readStream').mockImplementation(delayed);
  const head = vi.spyOn(nats.store, 'head');
  try {
    const response = await app.inject({ url: fixture.url, headers: headers() });
    expect(response.statusCode).toBe(200);
    expect(subjects.indexOf('member-alice')).toBeGreaterThan(subjects.indexOf(`mcp-${fixture.serverId}`));
    expect(subjects).not.toContain('conversation-busy');
    expect(head).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
  }
}
it('loads slow history before its one current-member check despite busy chat activity', slowRead);

async function lifecycle(action: string) {
  const fixture = await saved();
  await saved();
  let event;
  let expectedStatus = 'saved_unverified';
  let generation: number | null = 1;
  let serverAvailable = true;
  if (action === 'rotation') {
    const activation = { ...fixture.data.activation, generation: 2,
      operationId: `rotate${counter}`, reason: 'bearer_rotation', expectedSequence: fixture.revision };
    event = envelope('test', fixture.subject, 'connection.refreshed',
      { ...fixture.data, activation }, activation.operationId);
    event.principal = { kind: 'human', id: 'alice' };
    generation = 2;
  } else if (action === 'revocation') {
    event = envelope('test', fixture.subject, 'connection.revoked', {
      userId: 'alice', serverId: fixture.serverId, profile: fixture.profileId,
      revokedBy: 'alice', reason: 'owner_requested', expectedSequence: fixture.revision,
    });
    expectedStatus = 'unavailable';
    generation = null;
    serverAvailable = false;
  } else if (action === 'disable') {
    event = envelope('test', `connection-control-alice-${fixture.serverId}`, 'connection.disabled', {
      userId: 'alice', serverId: fixture.serverId, profile: fixture.profileId,
      disabledBy: 'admin', reason: 'admin_disabled', expectedSequence: 0,
    });
  } else {
    event = envelope('test', `mcp-${fixture.serverId}`, 'mcp.server_registered', {
      serverId: fixture.serverId, kind: 'remote', locator: 'https://replacement.test/mcp',
      registeredBy: 'admin',
    });
    serverAvailable = false;
  }
  await nats.seed([event]);
  const revision = await nats.store.head(fixture.subject);
  const append = vi.spyOn(nats.store, 'append');
  try {
    for (let repeat = 0; repeat < 2; repeat += 1) {
      const response = await app.inject({ url: fixture.url, headers: headers() });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ serverId: fixture.serverId, profileId: fixture.profileId,
        profileRevision: revision, status: expectedStatus, generation,
        adminBlocked: action === 'disable', serverAvailable, callsAvailable: false });
      expect(response.body).not.toContain(privateCanary);
    }
    expect(append).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
  }
}
it.each(['rotation', 'revocation', 'disable', 'replacement'])(
  'rebuilds exact %s facts from history without selecting another account or releasing', lifecycle);

async function legacyAndFailure() {
  const fixture = await saved();
  const originalRead = nats.store.readStream.bind(nats.store);
  async function* legacy(subject: string, from?: number, deadline?: number) {
    for await (const row of originalRead(subject, from, deadline)) {
      if (subject === fixture.subject) {
        const data = { userId: 'alice', serverId: fixture.serverId,
          profile: fixture.profileId, secretRef: `secret:${privateCanary}` };
        yield { ...row, event: { ...row.event, data } };
      } else {
        yield row;
      }
    }
  }
  const read = vi.spyOn(nats.store, 'readStream').mockImplementation(legacy);
  try {
    const response = await app.inject({ url: fixture.url, headers: headers() });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ serverId: fixture.serverId, profileId: fixture.profileId,
      profileRevision: fixture.revision, status: 'unavailable', generation: null,
      adminBlocked: false, serverAvailable: false, callsAvailable: false });
    function failed(subject: string, from?: number, deadline?: number) {
      if (subject === fixture.subject) throw new Error(privateCanary);
      return originalRead(subject, from, deadline);
    }
    read.mockImplementation(failed);
    const unavailable = await app.inject({ url: fixture.url, headers: headers() });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json()).toEqual({ status: 'unavailable' });
    expect(unavailable.headers['cache-control']).toBe('no-store');
  } finally {
    vi.restoreAllMocks();
  }
}
it('keeps incomplete legacy records unavailable and sanitises unreadable history', legacyAndFailure);
