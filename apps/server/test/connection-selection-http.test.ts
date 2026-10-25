import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { encodeSession } from '@opencrane/auth';
import { createStore, grantStream, memberAuthorisation } from '@opencrane/authz';
import { databases, openfga } from '@opencrane/authz/testing';
import { changePersonalConnection, foldConnection }
  from '../../../libs/models/src/bearer-connections.ts';
import { connectionCreatedDataSchema } from '@opencrane/events';
import { catalogueDigest } from '@opencrane/events/mcp-catalogue';
import { envelope, history } from '@opencrane/models';
import * as models from '@opencrane/models';
import * as custody from '../../../libs/models/src/connection-custody.ts';
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
  const selected = response.json<{ sequence: number }>();
  expect(selected).toEqual({ status: 'selected', sequence: await nats.store.head(`connection-selection-alice-${fixture.serverId}`),
    changeRef: 'choice' });
  const clear = { action: 'clear', connectionId: 'installed', changeRef: 'clear',
    expectedSequence: selected.sequence };
  const cleared = await post(fixture.url, clear);
  expect(cleared.statusCode).toBe(200);
  expect(cleared.json()).toEqual({ status: 'cleared', sequence: await nats.store.head(`connection-selection-alice-${fixture.serverId}`),
    changeRef: 'clear' });
  const position = await nats.store.head();
  expect((await post(fixture.url, input)).json()).toEqual(selected);
  expect((await post(fixture.url, clear)).json()).toEqual(cleared.json());
  expect(await nats.store.head()).toBe(position);
  const rows = await history(nats.store, `connection-selection-alice-${fixture.serverId}`, 'test');
  expect(rows).toHaveLength(2);
  expect(JSON.stringify(rows)).not.toContain(privateCanary);
}
it('saves an explicit select and clear once and returns their original receipts', savesOnce);

async function rejectsInput(patch: object) {
  const fixture = await saved();
  const position = await nats.store.head();
  const response = await post(fixture.url, { ...selection(fixture), ...patch });
  expect(response.statusCode).toBe(400);
  expect(response.json()).toEqual({ status: 'refused' });
  expect(await nats.store.head()).toBe(position);
}
it.each([{ extra: privateCanary }, { label: material }, { userId: 'alice' }, { ownerId: 'alice' }, { ownerKind: 'personal' },
  { silo: 'test' }, { serverId: 'other' }, { action: 'automatic' }, { action: 'clear' },
  { profileId: '' }, { changeRef: 'bad ref' }, { connectionId: 'x'.repeat(201) },
  { expectedSequence: -1 }, { expectedSequence: 0.5 }, { profileRevision: 0 }])(
  'refuses invalid or overridden fields %j without saving', rejectsInput);

async function boundary() {
  const fixture = await saved();
  const input = selection(fixture);
  const position = await nats.store.head();
  const anonymous = { origin: headers().origin, cookie: '' };
  expect((await post(fixture.url, input, anonymous)).statusCode).toBe(401);
  expect((await post(fixture.url, input, headers('alice', 'foreign'))).statusCode).toBe(403);
  for (const origin of ['', 'https://foreign.test', `${headers().origin}/`]) {
    expect((await post(fixture.url, input, { ...headers(), origin })).statusCode).toBe(403);
  }
  for (const member of ['bob', 'admin']) {
    expect((await post(fixture.url, input, headers(member))).statusCode).toBe(403);
    const forged = { ...input, userId: 'alice' };
    expect((await post(fixture.url, forged, headers(member))).statusCode).toBe(400);
  }
  expect((await post(`${fixture.url}?changeRef=other`, input)).statusCode).toBe(400);
  expect((await post(fixture.url.replace(fixture.serverId, 'bad%20id'), input)).statusCode).toBe(400);
  const jsonHeaders = { ...headers(), 'content-type': 'application/json' };
  for (const body of ['{', 'null', '[]']) {
    expect((await post(fixture.url, body, jsonHeaders)).statusCode).toBe(400);
  }
  expect((await post(fixture.url, 'x'.repeat(4097), jsonHeaders)).statusCode).toBe(413);
  await app.close();
  app = startApp(nats.store, 'foreign');
  expect((await post(fixture.url, input)).statusCode).toBe(403);
  await app.close();
  app = startApp();
  expect(await nats.store.head()).toBe(position);
}
it('requires the own session, silo and exact Origin and bounded JSON without query fields', boundary);

async function stale(patch: object) {
  const fixture = await saved();
  const position = await nats.store.head();
  const response = await post(fixture.url, { ...selection(fixture), ...patch });
  expect(response.statusCode).toBe(409);
  expect(response.json()).toEqual({ status: 'refused' });
  expect(await nats.store.head()).toBe(position);
}
it.each([{ expectedSequence: 1 }, { profileRevision: 1 }, { profileId: 'missing' },
  { connectionId: 'other' }])('refuses stale selection facts %j', stale);

async function recover(lost: boolean) {
  const fixture = await saved();
  const input = selection(fixture);
  const append = nats.store.append.bind(nats.store);
  async function loseReply(command: Parameters<typeof append>[0]): Promise<never> {
    await append(command);
    throw new Error(privateCanary);
  }
  if (lost) {
    vi.spyOn(nats.store, 'append').mockImplementationOnce(loseReply);
  }
  const first = await post(fixture.url, input);
  expect(first.statusCode).toBe(lost ? 503 : 200);
  vi.restoreAllMocks();
  const url = `${fixture.url}/changes/choice`;
  const recovered = await app.inject({ url, headers: headers() });
  expect(recovered.statusCode).toBe(200);
  const original = recovered.json<{ sequence: number }>();
  expect(original).toMatchObject({ status: 'confirmed', action: 'select', changeRef: 'choice',
    profileId: fixture.profileId, profileRevision: fixture.revision });
  const clear = { action: 'clear', connectionId: 'installed', changeRef: 'clear',
    expectedSequence: original.sequence };
  const cleared = await post(fixture.url, clear);
  expect(cleared.statusCode).toBe(200);
  await waitForDuplicateWindow(nats);
  const position = await nats.store.head();
  const noAppend = vi.spyOn(nats.store, 'append');
  try {
    const retry = await post(fixture.url, input);
    expect(retry.json()).toEqual({ status: 'selected', sequence: original.sequence,
      changeRef: 'choice' });
    expect((await post(fixture.url, clear)).json()).toEqual(cleared.json());
    expect((await post(fixture.url, { ...input, profileId: 'other' })).statusCode).toBe(409);
    expect((await post(fixture.url, { ...clear, changeRef: 'choice' })).statusCode).toBe(409);
    expect((await post(fixture.url, { ...input, changeRef: 'new' })).statusCode).toBe(409);
    expect(noAppend).not.toHaveBeenCalled();
    expect(await nats.store.head()).toBe(position);
    const missing = await app.inject({ url: `${fixture.url}/changes/missing`, headers: headers() });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ status: 'unknown' });
  } finally {
    vi.restoreAllMocks();
  }
}
it.each([false, true])('recovers the original after later changes and expiry (lost reply: %s)', recover);

async function unknownAppend() {
  const fixture = await saved();
  const position = await nats.store.head();
  const append = vi.spyOn(nats.store, 'append');
  append.mockResolvedValueOnce({ status: 'unavailable', cause: new Error(privateCanary) });
  try {
    const response = await post(fixture.url, selection(fixture));
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'unavailable' });
    expect(append).toHaveBeenCalledTimes(1);
    expect(await nats.store.head()).toBe(position);
    const url = `${fixture.url}/changes/choice`;
    const missing = await app.inject({ url, headers: headers() });
    expect(missing.json()).toEqual({ status: 'unknown' });
  } finally {
    vi.restoreAllMocks();
  }
}
it('keeps an unconfirmed append unavailable without automatically resending', unknownAppend);

async function unavailableProfile(kind: string) {
  const fixture = await saved();
  if (kind === 'revoke' || kind === 'disable') {
    const expectedSequence = kind === 'disable' ? 0 : fixture.revision;
    const actor = kind === 'disable' ? 'admin' : 'alice';
    const input = { action: kind, userId: 'alice', serverId: fixture.serverId,
      profileId: fixture.profileId, changeRef: kind, expectedSequence };
    await changePersonalConnection(nats.store, binding, actor, input);
  }
  const rows = await history(nats.store, fixture.subject, 'test');
  const row = rows[0]!;
  const profile = connectionCreatedDataSchema.parse(row.event.data);
  if (kind === 'foreign') {
    profile.userId = 'bob';
    profile.activation!.changedBy = 'bob';
    row.event.subject = `connection-bob-${fixture.serverId}-${fixture.profileId}`;
    row.event.principal = { kind: 'human', id: 'bob' };
    row.event.data = profile;
    expect(foldConnection(rows).status).toBe('saved_unverified');
  } else if (kind === 'company' || kind === 'validation') {
    row.event.data = { ...profile, activation: { ...profile.activation, ownerKind: kind } };
  }
  const read = nats.store.readStream.bind(nats.store);
  async function* replace(subject: string, from?: number, deadline?: number) {
    if (subject === fixture.subject) {
      yield* rows;
      return;
    }
    yield* read(subject, from, deadline);
  }
  vi.spyOn(nats.store, 'readStream').mockImplementation(replace);
  const position = await nats.store.head();
  try {
    expect((await post(fixture.url, selection(fixture))).statusCode).toBe(409);
    expect(await nats.store.head()).toBe(position);
  } finally {
    vi.restoreAllMocks();
  }
}
it.each(['foreign', 'company', 'validation', 'revoke', 'disable'])(
  'refuses a %s profile without saving or choosing another account', unavailableProfile);

async function accessRace(kind: string) {
  const fixture = await saved();
  const read = nats.store.readStream.bind(nats.store);
  const append = nats.store.append.bind(nats.store);
  let delayed = false;
  let removal: ReturnType<typeof envelope> | undefined;
  async function* load(subject: string, from?: number, deadline?: number) {
    expect(subject).not.toMatch(/^conversation-/u);
    if (!delayed && subject === fixture.subject) {
      delayed = true;
      expect(deadline! - performance.now()).toBeGreaterThan(2_000);
      await delay(2_100);
      await nats.seed([envelope('test', 'conversation-busy', 'conversation.closed',
        { conversationId: 'busy', closedBy: 'alice' })]);
    }
    yield* read(subject, from, deadline);
  }
  async function race(command: Parameters<typeof append>[0]) {
    expect(command.deadline! - performance.now()).toBeLessThanOrEqual(2_000);
    if (kind === 'remove') {
      removal = envelope('test', 'member-alice', 'member.removed',
        { memberId: 'alice', removedBy: 'admin' });
      await nats.seed([removal]);
    } else if (kind === 'grant') {
      const event = envelope('test', grantStream('mcp_server', fixture.serverId), 'grant.revoked', {
        resourceType: 'mcp_server', resourceId: fixture.serverId, granteeKind: 'member',
        granteeId: 'alice', revokedBy: 'admin',
      });
      await nats.seed([event]);
    } else {
      await nats.seed([envelope('test', 'conversation-busy', 'conversation.closed',
        { conversationId: 'busy', closedBy: 'alice' })]);
    }
    return append(command);
  }
  vi.spyOn(nats.store, 'readStream').mockImplementation(load);
  vi.spyOn(nats.store, 'append').mockImplementation(race);
  try {
    const response = await post(fixture.url, selection(fixture));
    expect(response.statusCode).toBe(kind === 'chat' ? 200 : 503);
    const subject = `connection-selection-alice-${fixture.serverId}`;
    const rows = await history(nats.store, subject, 'test');
    expect(rows).toHaveLength(kind === 'chat' ? 1 : 0);
  } finally {
    vi.restoreAllMocks();
    if (removal) {
      await memberAuthorisation(binding).handler.handle(removal, pgDb(storage.queue));
      await join('alice');
    }
  }
}
it.each(['remove', 'grant', 'chat'])(
  'loads slow history before the short access check and handles a %s race', accessRace);

async function clearReplacement() {
  const fixture = await saved();
  const selected = await post(fixture.url, selection(fixture));
  expect(selected.statusCode).toBe(200);
  const event = envelope('test', `mcp-${fixture.serverId}`, 'mcp.server_registered', {
    serverId: fixture.serverId, kind: 'remote', locator: 'https://replacement.test/mcp',
    registeredBy: 'admin',
  });
  await nats.seed([event]);
  const input = { action: 'clear', connectionId: 'installed', changeRef: 'clear',
    expectedSequence: selected.json<{ sequence: number }>().sequence };
  expect((await post(fixture.url, input)).statusCode).toBe(200);
}
it('can still clear the saved choice after installation replacement', clearReplacement);


async function noExternalEffects() {
  const fixture = await saved();
  const append = vi.spyOn(nats.store, 'append');
  const provider = vi.spyOn(globalThis, 'fetch');
  const credentials = vi.spyOn(custody, 'connectionCustody');
  const wake = vi.spyOn(models, 'mcpInstanceCommand');
  try {
    expect((await post(fixture.url, selection(fixture))).statusCode).toBe(200);
    expect(append).toHaveBeenCalledTimes(1);
    expect(append.mock.calls[0]![0].event).toMatchObject({ type: 'connection.selected' });
    expect(provider).not.toHaveBeenCalled();
    expect(credentials).not.toHaveBeenCalled();
    expect(wake).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
  }
}
it('saves only the choice, with no custody, provider, credential release or wake calls', noExternalEffects);


async function anotherMemberWithToolAccess(member: string) {
  const fixture = await saved();
  const grant = envelope('test', grantStream('mcp_server', fixture.serverId), 'grant.given', {
    resourceType: 'mcp_server', resourceId: fixture.serverId, granteeKind: 'member',
    granteeId: member, grantedBy: 'admin',
  });
  await nats.seed([grant]);
  await memberAuthorisation(binding).handler.handle(grant, pgDb(storage.queue));
  const position = await nats.store.head();
  expect((await post(fixture.url, selection(fixture), headers(member))).statusCode).toBe(409);
  expect(await nats.store.head()).toBe(position);
}
it.each(['bob', 'admin'])('tool access does not let %s select Alice’s profile',
  anotherMemberWithToolAccess);
