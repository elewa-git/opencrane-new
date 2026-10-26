import { OpenFgaClient } from '@openfga/sdk';
import { setTimeout as delay } from 'node:timers/promises';
import * as custody from '../../../libs/models/src/connection-custody.ts';
import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { encodeSession } from '@opencrane/auth';
import { createStore, memberAuthorisation } from '@opencrane/authz';
import { databases, openfga } from '@opencrane/authz/testing';
import type { FastifyRequest } from 'fastify';
import { shortDuplicateWindowFixture, waitForDuplicateWindow }
  from './support/duplicate-window.ts';
import { catalogueDigest } from '@opencrane/events/mcp-catalogue';
import { envelope, history, saveBearerConnection } from '@opencrane/models';
import { pgDb } from '@opencrane/projections';
import { buildServer } from '../src/server.ts';
import { testAuthConfig } from './support/test-auth-config.ts';

const config = testAuthConfig({ expectedOrgId: 'org-test' });
const privateCanary = 'private-custody-canary';
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
  nats = await shortDuplicateWindowFixture();
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
    return Promise.resolve(subject === 'unmapped' ? undefined : subject.replace('session-', ''));
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
  return { cookie: `${config.cookieName}=${encodeSession(config, session)}`,
    origin: new URL(config.redirectUri).origin };
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
async function post(url: string, payload: object | string, requestHeaders = headers()) {
  const request = { method: 'POST' as const, url: `${url}/disable`, payload,
    headers: requestHeaders };
  const response = await app.inject(request);
  privateOutput(response);
  return response;
}
async function metadata(url: string) {
  const response = await app.inject({ url, headers: headers() });
  privateOutput(response);
  expect(response.statusCode).toBe(200);
  return response.json<{ controlRevision: number; profileRevision: number }>();
}
function requestUrl(input: Parameters<typeof fetch>[0]) {
  if (typeof input === 'string') {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
}
const input = { changeRef: 'disable', expectedSequence: 0 };

async function recover(actor: string, lost: boolean) {
  const fixture = await saved();
  const before = await metadata(fixture.url);
  expect(before.controlRevision).toBe(0);
  expect(before.profileRevision).toBe(fixture.revision);
  const command = { ...input, expectedSequence: before.controlRevision };
  const append = nats.store.append.bind(nats.store);
  async function loseReply(request: Parameters<typeof append>[0]): Promise<never> {
    await append(request);
    throw new Error(privateCanary);
  }
  const noCustody = vi.spyOn(custody, 'connectionCustody');
  const fetch = vi.spyOn(globalThis, 'fetch');
  const writes = vi.spyOn(nats.store, 'append');
  if (lost) {
    writes.mockImplementationOnce(loseReply);
  }
  const response = await post(fixture.url, command, headers(`session-${actor}`));
  expect(response.statusCode).toBe(lost ? 503 : 200);
  expect(writes).toHaveBeenCalledTimes(1);
  writes.mockRestore();
  await waitForDuplicateWindow(nats);
  await app.close();
  app = startApp();
  const position = await nats.store.head();
  const noAppend = vi.spyOn(nats.store, 'append');
  const retry = await post(fixture.url, command, headers(`session-${actor}`));
  expect(retry.statusCode).toBe(200);
  const rows = await history(nats.store, `connection-control-alice-${fixture.serverId}`, 'test');
  expect(rows).toHaveLength(1);
  const receipt = { status: 'disabled', sequence: rows[0]!.sequence, changeRef: 'disable' };
  expect(retry.json()).toEqual(receipt);
  if (!lost) {
    expect(response.json()).toEqual(receipt);
  }
  expect(rows[0]!.event).toMatchObject({ type: 'connection.disabled',
    principal: { kind: 'human', id: actor }, data: { userId: 'alice',
      serverId: fixture.serverId, profile: fixture.profileId, expectedSequence: 0,
      disabledBy: actor, reason: 'admin_disabled' } });
  for (const changed of [{ ...command, expectedSequence: receipt.sequence },
    { ...command, changeRef: 'other' }]) {
    const refused = await post(fixture.url, changed, headers(actor));
    expect(refused.statusCode).toBe(503);
    expect(refused.json()).toEqual({ status: 'unavailable' });
  }
  const replacement = await saved(fixture.serverId);
  const changedTarget = await post(replacement.url, command, headers(actor));
  expect(changedTarget.statusCode).toBe(503);
  const read = await app.inject({ url: replacement.url, headers: headers() });
  expect(read.json()).toMatchObject({ controlRevision: receipt.sequence,
    adminBlocked: true, status: 'saved_unverified', callsAvailable: false });
  expect(await nats.store.head(fixture.subject)).toBe(fixture.revision);
  expect(noAppend).not.toHaveBeenCalled();
  expect(noCustody).not.toHaveBeenCalled();
  // Allow only the existing permission service to receive HTTP calls.
  for (const [url] of fetch.mock.calls) {
    expect(requestUrl(url).startsWith(fga.apiUrl)).toBe(true);
  }
  // Seeding the replacement adds its profile and four server events only.
  expect(await nats.store.head()).toBe(position + 5);
}
it.each([['admin', false], ['owner', false], ['admin', true]] as const)(
  'saves once for %s and recovers after deduplication expiry (lost: %s)', recover);

async function refusedActor(actor: string, outcome: string) {
  const fixture = await saved();
  const read = nats.store.readStream.bind(nats.store);
  async function* load(subject: string, from?: number, deadline?: number) {
    if (subject === fixture.subject) {
      if (outcome === 'missing') {
        return;
      }
      if (outcome === 'failed') {
        throw new Error(privateCanary);
      }
    }
    yield* read(subject, from, deadline);
  }
  vi.spyOn(nats.store, 'readStream').mockImplementation(load);
  const writes = vi.spyOn(nats.store, 'append');
  let requestHeaders = headers(actor);
  if (actor === 'foreign') {
    requestHeaders = headers('admin', 'foreign');
  }
  if (actor === 'origin') {
    requestHeaders = { ...headers(), origin: 'https://foreign.test' };
  }
  const response = await post(fixture.url, input, requestHeaders);
  expect(response.statusCode).toBe(403);
  expect(response.json()).toEqual({ status: 'refused' });
  expect(writes).not.toHaveBeenCalled();
}
const refusals: [string, string][] = [];
for (const actor of ['alice', 'bob', 'unmapped', 'unknown', 'foreign', 'origin']) {
  for (const outcome of ['saved', 'missing', 'failed']) {
    refusals.push([actor, outcome]);
  }
}
it.each(refusals)('refuses %s with %s history without target details', refusedActor);

async function permissionOrdering(outcome: string, retry: boolean) {
  const fixture = await saved();
  if (retry) {
    expect((await post(fixture.url, input)).statusCode).toBe(200);
  }
  const position = await nats.store.head();
  const read = nats.store.readStream.bind(nats.store);
  const client = new OpenFgaClient(binding);
  const check = client.check.bind(client);
  let prepared = false;
  let checks = 0;
  let changed: ReturnType<typeof envelope> | undefined;
  async function* load(subject: string, from?: number, deadline?: number) {
    expect(subject).not.toMatch(/^conversation-/u);
    if (subject === fixture.subject) {
      expect(deadline! - performance.now()).toBeGreaterThan(2_000);
      prepared = true;
      if (outcome.startsWith('removed') || outcome === 'demoted') {
        let type = 'member.removed';
        let data: Record<string, unknown> = { memberId: 'admin', removedBy: 'owner' };
        if (outcome === 'demoted') {
          type = 'member.role_changed';
          data = { memberId: 'admin', previousRole: 'admin', newRole: 'member', changedBy: 'owner' };
        }
        changed = envelope('test', 'member-admin', type, data);
        await nats.seed([changed]);
      }
      if (outcome.includes('failed')) {
        throw new Error(privateCanary);
      }
      if (outcome.includes('missing')) {
        return;
      }
      if (outcome === 'slow') {
        await delay(2_100);
      }
    }
    yield* read(subject, from, deadline);
  }
  async function permission(...args: Parameters<typeof check>) {
    if (args[0].relation === 'admin') {
      expect(prepared).toBe(true);
      checks += 1;
      if (checks > 1) {
        throw new Error(privateCanary);
      }
      if (outcome === 'denied') {
        return { ...await check(...args), allowed: false };
      }
    }
    return check(...args);
  }
  vi.spyOn(nats.store, 'readStream').mockImplementation(load);
  vi.spyOn(OpenFgaClient.prototype, 'check').mockImplementation(permission);
  const writes = vi.spyOn(nats.store, 'append');
  let expected = 503;
  if (outcome.startsWith('removed') || outcome === 'demoted' || outcome === 'denied') {
    expected = 403;
  } else if (outcome === 'success' || outcome === 'slow') {
    expected = 200;
  }
  const command = { ...input };
  if (outcome === 'stale') {
    command.expectedSequence = fixture.revision;
  }
  try {
    const response = await post(fixture.url, command);
    expect(response.statusCode).toBe(expected);
    expect(checks).toBe(changed ? 0 : 1);
    if (expected !== 200) {
      expect(response.json()).toEqual({ status: expected === 403 ? 'refused' : 'unavailable' });
      expect(writes).not.toHaveBeenCalled();
      expect(await nats.store.head()).toBe(position + (changed ? 1 : 0));
    } else {
      expect(writes).toHaveBeenCalledTimes(retry ? 0 : 1);
      if (!retry) {
        expect(writes.mock.calls[0]![0]).toMatchObject({ expectedSequence: 0,
          event: { subject: `connection-control-alice-${fixture.serverId}` } });
      }
    }
  } finally {
    vi.restoreAllMocks();
    if (changed) {
      await memberAuthorisation(binding).handler.handle(changed, pgDb(storage.queue));
      await join('admin');
    }
  }
}
const ordering: [string, boolean][] = [];
for (const outcome of ['success', 'failed', 'missing', 'stale', 'denied', 'slow',
  'removed', 'removed failed', 'removed missing', 'demoted']) {
  ordering.push([outcome, false]);
  if (outcome.startsWith('removed') || outcome === 'demoted' || outcome === 'denied') {
    ordering.push([outcome, true]);
  }
}
it.each(ordering)('checks access after %s history (saved retry: %s)', permissionOrdering);

async function strictInput() {
  const fixture = await saved();
  const position = await nats.store.head();
  for (const patch of [{ action: 'revoke' }, { userId: 'admin' }, { serverId: 'other' },
    { profileId: 'other' }, { reason: privateCanary }, { changeRef: '' },
    { changeRef: 'bad ref' }, { changeRef: 'x'.repeat(201) },
    { expectedSequence: -1 }, { expectedSequence: 0.5 }]) {
    expect((await post(fixture.url, { ...input, ...patch })).statusCode).toBe(400);
  }
  const query = await app.inject({ method: 'POST', url: `${fixture.url}/disable?extra=value`,
    payload: input, headers: headers() });
  privateOutput(query);
  expect(query.statusCode).toBe(400);
  const jsonHeaders = { ...headers(), 'content-type': 'application/json' };
  for (const payload of ['{', 'null', '[]']) {
    expect((await post(fixture.url, payload, jsonHeaders)).statusCode).toBe(400);
  }
  expect((await post(fixture.url, 'x'.repeat(4097), jsonHeaders)).statusCode).toBe(413);
  expect((await post(fixture.url, input, { ...headers(), cookie: '' })).statusCode).toBe(401);
  for (const origin of ['', `${headers().origin}/`]) {
    expect((await post(fixture.url, input, { ...headers(), origin })).statusCode).toBe(403);
  }
  expect(await nats.store.head()).toBe(position);
}
it('requires bounded strict JSON, empty query, a session and exact Origin', strictInput);

async function strictParameters(patch: object) {
  const fixture = await saved();
  await app.close();
  app = startApp();
  function replace(request: FastifyRequest) {
    request.params = { userId: 'alice', serverId: fixture.serverId,
      profileId: fixture.profileId, ...patch };
    return Promise.resolve();
  }
  app.addHook('onRequest', replace);
  const writes = vi.spyOn(nats.store, 'append');
  try {
    expect((await post(fixture.url, input)).statusCode).toBe(400);
    expect(writes).not.toHaveBeenCalled();
  } finally {
    await app.close();
    app = startApp();
  }
}
it.each([{ userId: 'bad id' }, { userId: 'x'.repeat(201) }, { serverId: 'x'.repeat(201) },
  { profileId: 'x'.repeat(201) }, { extra: 'value' }])('refuses invalid path %j', strictParameters);

async function competingSave(action: 'rotate' | 'create', disableFirst: boolean) {
  const fixture = await saved();
  const command = { action, serverId: fixture.serverId, connectionId: 'installed',
    profileId: fixture.profileId, changeRef: 'replacement', expectedSequence: fixture.revision,
    expectedGeneration: 1, appendUntil: Date.now() + 60_000 };
  if (action === 'create') {
    command.profileId = 'replacement';
    command.expectedSequence = 0;
    command.expectedGeneration = 0;
  }
  function stage() {
    const result = { status: 'staged' as const, identity: {
      reference: 'replacement', uid: 'replacement', resourceVersion: '1' } };
    return Promise.resolve(result);
  }
  const adapter = { stage };
  const database = pgDb(storage.queue);
  async function save() {
    return saveBearerConnection(nats.store, binding, 'alice', adapter,
      command, privateCanary, database);
  }
  const append = nats.store.append.bind(nats.store);
  async function interleave(request: Parameters<typeof append>[0]) {
    writes.mockRestore();
    if (disableFirst) {
      expect((await post(fixture.url, input)).statusCode).toBe(200);
    } else {
      await save();
    }
    return append(request);
  }
  const writes = vi.spyOn(nats.store, 'append').mockImplementationOnce(interleave);
  if (disableFirst) {
    await expect(save()).rejects.toThrow('Connection append unconfirmed');
    const subject = `connection-alice-${command.serverId}-${command.profileId}`;
    expect(await nats.store.head(subject)).toBe(command.expectedSequence);
  } else {
    expect((await post(fixture.url, input)).statusCode).toBe(200);
  }
  const rows = await history(nats.store, `connection-control-alice-${fixture.serverId}`, 'test');
  expect(rows).toHaveLength(1);
  await expect(save()).rejects.toThrow('Connection disabled');
  command.action = 'create';
  command.profileId = 'later';
  command.expectedSequence = 0;
  command.expectedGeneration = 0;
  await expect(save()).rejects.toThrow('Connection disabled');
}
it.each([['rotate', true], ['create', true], ['rotate', false], ['create', false]] as const)(
  'keeps the block across concurrent %s (disable first: %s)', competingSave);

async function missingSetup(kind: string) {
  const fixture = await saved();
  await app.close();
  function memberId(): never {
    throw new Error(privateCanary);
  }
  const memberReads = { silo: 'test', store: nats.store, binding,
    db: pgDb(storage.queue), feed: { memberId } };
  if (kind === 'silo') {
    memberReads.silo = 'foreign';
  }
  if (kind === 'configuration') {
    app = buildServer(config, { logDestination: { write } });
  } else {
    app = buildServer(config, { memberReads, logDestination: { write } });
  }
  try {
    const response = await post(fixture.url, input);
    expect(response.statusCode).toBe(kind === 'silo' ? 403 : 503);
    expect(response.json()).toEqual({ status: kind === 'silo' ? 'refused' : 'unavailable' });
  } finally {
    await app.close();
    app = startApp();
  }
}
it.each(['configuration', 'silo', 'lookup'])('keeps %s failure private', missingSetup);

async function simultaneousDisables() {
  const fixture = await saved();
  const append = nats.store.append.bind(nats.store);
  const ready = Promise.withResolvers<void>();
  let attempts = 0;
  async function together(command: Parameters<typeof append>[0]) {
    attempts += 1;
    if (attempts === 2) {
      ready.resolve();
    }
    await ready.promise;
    return append(command);
  }
  vi.spyOn(nats.store, 'append').mockImplementation(together);
  const requests = [post(fixture.url, input), post(fixture.url, input)];
  const [first, second] = await Promise.all(requests);
  expect(first!.statusCode).toBe(200);
  expect(second!.statusCode).toBe(200);
  expect(second!.json()).toEqual(first!.json());
  const rows = await history(nats.store, `connection-control-alice-${fixture.serverId}`, 'test');
  expect(rows).toHaveLength(1);
}
it('saves one block when two HTTP requests reach append together', simultaneousDisables);
