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
  vi.stubEnv('LOG_LEVEL', 'info');
  app = startApp();
}
function startApp() {
  function memberId(_silo: string, _issuer: string, subject: string) {
    return Promise.resolve(subject === 'unmapped' ? undefined : subject);
  }
  const memberReads = { silo: 'test', store: nats.store, binding,
    db: pgDb(storage.queue), feed: { memberId } };
  return buildServer(config, { memberReads, logDestination: { write } });
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
function isPermissionCheck(call: Parameters<OpenFgaClient['check']>) {
  return call[0].relation === 'admin';
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
  const permissions = check.mock.calls.filter(isPermissionCheck);
  expect(permissions).toHaveLength(1);
  expect(check.mock.calls[0]?.[0].relation).toBe('admin');
  expect(head).not.toHaveBeenCalled();
  expect(append).not.toHaveBeenCalled();
  expect(noCustody).not.toHaveBeenCalled();
  for (const [request] of provider.mock.calls) {
    let address: string;
    if (request instanceof Request) {
      address = request.url;
    } else {
      address = String(request);
    }
    expect(address.startsWith(fga.apiUrl)).toBe(true);
  }
}
it.each(['admin', 'owner'])('lets current %s inspect safe metadata without effects', readsSafeMetadata);

async function refusesSessions() {
  const fixture = await saved();
  for (const actor of ['alice', 'bob', 'unmapped']) {
    for (const url of [fixture.url, `${fixture.url}-missing`]) {
      const response = await app.inject({ url, headers: headers(actor) });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ status: 'refused' });
      privateOutput(response);
    }
  }
  const foreign = await app.inject({ url: fixture.url, headers: headers('admin', 'foreign') });
  expect(foreign.statusCode).toBe(403);
  privateOutput(foreign);
  const anonymous = await app.inject({ url: fixture.url });
  expect(anonymous.statusCode).toBe(401);
  privateOutput(anonymous);
}
it('ignores cookie roles and refuses members, unmapped and foreign sessions', refusesSessions);

async function rejectsOverrides() {
  const fixture = await saved();
  for (const key of ['userId', 'ownerId', 'siloId', 'profileId', 'serverId']) {
    const response = await app.inject({ url: `${fixture.url}?${key}=other`, headers: headers() });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ status: 'refused' });
    privateOutput(response);
  }
  for (const framing of [{ 'content-length': '1' }, { 'transfer-encoding': 'chunked' }]) {
    const response = await app.inject({ url: fixture.url, headers: { ...headers(), ...framing } });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ status: 'refused' });
    privateOutput(response);
  }
}
it('rejects identity overrides and both forms of GET body framing', rejectsOverrides);

async function orderedAccess(outcome: string) {
  const fixture = await saved();
  const read = nats.store.readStream.bind(nats.store);
  const client = new OpenFgaClient(binding);
  const check = client.check.bind(client);
  const subjects: string[] = [];
  const deadlines: number[] = [];
  let permissionChecks = 0;
  let changed: ReturnType<typeof envelope> | undefined;
  async function permission(...args: Parameters<typeof check>) {
    if (args[0].relation === 'admin') {
      permissionChecks += 1;
      expect(subjects).toContain(fixture.subject);
      if (permissionChecks > 1) {
        throw new Error(privateCanary);
      }
      if (outcome === 'denied') {
        return { ...await check(...args), allowed: false };
      }
    }
    return check(...args);
  }
  async function* prepare(subject: string, from?: number, deadline?: number) {
    subjects.push(subject);
    if (!subject.startsWith('member-') && subject !== 'ownership-test') {
      deadlines.push(deadline!);
      expect(deadline! - performance.now()).toBeLessThanOrEqual(10_000);
      expect(deadline! - performance.now()).toBeGreaterThan(0);
    }
    if (subject === fixture.subject) {
      if (outcome.startsWith('demoted') || outcome === 'removed') {
        let data: Record<string, unknown> = { memberId: 'admin', previousRole: 'admin',
          newRole: 'member', changedBy: 'owner' };
        let type = 'member.role_changed';
        if (outcome === 'removed') {
          type = 'member.removed';
          data = { memberId: 'admin', removedBy: 'owner' };
        }
        changed = envelope('test', 'member-admin', type, data);
        await nats.seed([changed]);
      }
      if (outcome === 'slow') {
        await delay(2_100);
        const chat = envelope('test', 'conversation-busy', 'conversation.closed',
          { conversationId: 'busy', closedBy: 'alice' });
        await nats.seed([chat]);
      }
      if (outcome.endsWith('missing')) {
        return;
      }
    }
    if ((subject === fixture.subject && outcome.endsWith('failed')) ||
        (subject.startsWith('connection-control-') && outcome === 'control failed') ||
        (subject.startsWith('mcp-') && outcome === 'server failed')) {
      throw new Error(privateCanary);
    }
    yield* read(subject, from, deadline);
  }
  vi.spyOn(nats.store, 'readStream').mockImplementation(prepare);
  vi.spyOn(OpenFgaClient.prototype, 'check').mockImplementation(permission);
  const head = vi.spyOn(nats.store, 'head');
  try {
    const response = await app.inject({ url: fixture.url, headers: headers() });
    let code = 200;
    let status = 'saved_unverified';
    if (outcome.startsWith('demoted') || outcome === 'removed' || outcome === 'denied') {
      code = 403;
      status = 'refused';
    } else if (outcome.endsWith('failed')) {
      code = 503;
      status = 'unavailable';
    } else if (outcome === 'missing') {
      code = 404;
      status = 'unknown';
    }
    expect(response.statusCode).toBe(code);
    if (code !== 200) {
      expect(response.json()).toEqual({ status });
    }
    privateOutput(response);
    expect(subjects.filter(isAdminHistory)).toEqual(['member-admin']);
    expect(subjects.slice(-2)).toEqual(['member-admin', 'ownership-test']);
    expect(subjects[0]).toBe(fixture.subject);
    expect(subjects).not.toContain('conversation-busy');
    expect(new Set(deadlines).size).toBe(1);
    expect(head).not.toHaveBeenCalled();
    let expectedChecks = 1;
    if (outcome.startsWith('demoted') || outcome === 'removed') {
      expectedChecks = 0;
    }
    expect(permissionChecks).toBe(expectedChecks);
  } finally {
    vi.restoreAllMocks();
    if (changed) {
      await memberAuthorisation(binding).handler.handle(changed, pgDb(storage.queue));
    }
    await join('admin');
  }
}
function isAdminHistory(subject: string) {
  return subject === 'member-admin';
}
it.each(['success', 'missing', 'failed', 'control failed', 'server failed', 'denied',
  'demoted', 'demoted failed', 'demoted missing', 'removed', 'slow'])(
  'checks current access once after %s history without a write check', orderedAccess);

async function rejectsInvalidHistory(kind: string) {
  const fixture = await saved();
  const read = nats.store.readStream.bind(nats.store);
  async function* corrupt(subject: string, from?: number, deadline?: number) {
    for await (const row of read(subject, from, deadline)) {
      if (subject !== fixture.subject) {
        yield row;
        continue;
      }
      const event = structuredClone(row.event);
      const data: Record<string, unknown> = { ...fixture.data };
      const activation: Record<string, unknown> = { ...fixture.data.activation };
      data['activation'] = activation;
      if (['userId', 'serverId', 'profile'].includes(kind)) {
        data[kind] = 'foreign';
      } else if (kind === 'silo') {
        event.silo = 'foreign';
      } else if (kind === 'subject') {
        event.subject = 'connection-foreign';
      } else if (kind === 'legacy') {
        delete data['activation'];
      } else if (kind === 'company' || kind === 'validation') {
        activation['ownerKind'] = kind;
        activation['purpose'] = kind;
      } else if (kind === 'uid') {
        activation[kind] = '';
      } else {
        activation[kind] = 'invalid';
      }
      event.data = data;
      yield { ...row, event };
    }
  }
  vi.spyOn(nats.store, 'readStream').mockImplementation(corrupt);
  const response = await app.inject({ url: fixture.url, headers: headers() });
  if (kind === 'silo') {
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'unavailable' });
  } else {
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ status: 'unknown' });
  }
  privateOutput(response);
}
it.each(['userId', 'serverId', 'profile', 'silo', 'subject', 'legacy', 'company', 'validation',
  'uid', 'generation', 'operationId', 'changedBy', 'expectedSequence'])(
  'reveals no bindings for a target with invalid %s', rejectsInvalidHistory);

async function lifecycle(action: string) {
  const fixture = await saved();
  let generation: number | null = 1;
  let status = 'saved_unverified';
  let serverAvailable = true;
  let controlRevision = 0;
  let event;
  if (action === 'rotation') {
    const activation = { ...fixture.data.activation, generation: 2,
      operationId: `rotate${counter}`, reason: 'bearer_rotation', expectedSequence: fixture.revision };
    event = envelope('test', fixture.subject, 'connection.refreshed',
      { ...fixture.data, activation }, activation.operationId);
    event.principal = { kind: 'human', id: 'alice' };
    generation = 2;
  } else if (action === 'revoke') {
    event = envelope('test', fixture.subject, 'connection.revoked', {
      userId: 'alice', serverId: fixture.serverId, profile: fixture.profileId,
      revokedBy: 'alice', reason: 'owner_requested', expectedSequence: fixture.revision,
    });
    generation = null;
    status = 'unavailable';
    serverAvailable = false;
  } else {
    event = envelope('test', `connection-control-alice-${fixture.serverId}`, 'connection.disabled', {
      userId: 'alice', serverId: fixture.serverId, profile: fixture.profileId,
      disabledBy: 'admin', reason: 'admin_disabled', expectedSequence: 0,
    });
  }
  await nats.seed([event]);
  const profileRevision = await nats.store.head(fixture.subject);
  if (action === 'disable') {
    controlRevision = await nats.store.head(event.subject);
    const reconnect = await saved(fixture.serverId);
    const blocked = await app.inject({ url: reconnect.url, headers: headers() });
    expect(blocked.json()).toMatchObject({ adminBlocked: true, controlRevision,
      callsAvailable: false });
  }
  const append = vi.spyOn(nats.store, 'append');
  const noCustody = vi.spyOn(custody, 'connectionCustody');
  for (let repeat = 0; repeat < 2; repeat += 1) {
    await app.close();
    app = startApp();
    const response = await app.inject({ url: fixture.url, headers: headers() });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ serverId: fixture.serverId, profileId: fixture.profileId,
      profileRevision, controlRevision, status, generation, serverAvailable,
      adminBlocked: action === 'disable', callsAvailable: false });
    privateOutput(response);
  }
  expect(append).not.toHaveBeenCalled();
  expect(noCustody).not.toHaveBeenCalled();
}
it.each(['rotation', 'revoke', 'disable'])(
  'replays %s with exact profile and control revisions and no effects', lifecycle);
