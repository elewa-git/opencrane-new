import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { createEventStore, type StoredEvent } from '@opencrane/event-store';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { encodeSession } from '@opencrane/auth';
import { createStore, grantStream, memberAuthorisation } from '@opencrane/authz';
import { databases, openfga } from '@opencrane/authz/testing';
import { catalogueDigest } from '@opencrane/events/mcp-catalogue';
import { envelope, history, saveBearerConnection, readOwnSelectionChange } from '@opencrane/models';
import { changeConnectionSelection, readConnectionSelection }
  from '../../../libs/models/src/connection-selection.ts';
import { changePersonalConnection } from '../../../libs/models/src/bearer-connections.ts';
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
function startApp(store = nats.store) {
  function memberId(_silo: string, _issuer: string, subject: string) {
    return Promise.resolve(subject);
  }
  const memberReads = { silo: 'test', store, binding,
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
  return { cookie: `${config.cookieName}=${encodeSession(config, session)}` };
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
function receiptUrl(fixture: Awaited<ReturnType<typeof saved>>, changeRef = fixture.changeRef) {
  return `${fixture.url}/changes/${changeRef}`;
}
async function get(url: string, member = 'alice') {
  const position = await nats.store.head();
  const response = await app.inject({ url, headers: headers(member) });
  expect(await nats.store.head()).toBe(position);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.body).not.toContain(privateCanary);
  expect(response.body).not.toContain(material);
  expect(logs.join('\n')).not.toContain(privateCanary);
  expect(logs.join('\n')).not.toContain(material);
  return response;
}
function expectedReceipt(row: StoredEvent, action: string, profileRevision: number, profileId: string) {
  const receipt = { status: 'confirmed', changeRef: row.event.commandId,
    eventId: row.event.id, eventType: 'connection.selected', recordedAt: row.event.time,
    sequence: row.sequence, action };
  if (action === 'clear') {
    return receipt;
  }
  return { ...receipt, profileId, profileRevision };
}
async function recoverOriginal(later: string) {
  const fixture = await saved();
  const subject = `connection-selection-alice-${fixture.serverId}`;
  const input = { action: 'select', serverId: fixture.serverId, connectionId: 'installed',
    profileId: fixture.profileId, profileRevision: fixture.revision,
    changeRef: 'lost', expectedSequence: 0 };
  const append = nats.store.append.bind(nats.store);
  async function loseReply(command: Parameters<typeof append>[0]): Promise<never> {
    await append(command);
    throw new Error('Lost reply');
  }
  vi.spyOn(nats.store, 'append').mockImplementationOnce(loseReply);
  await expect(changeConnectionSelection(nats.store, binding, 'alice', input))
    .rejects.toThrow('Lost reply');
  vi.restoreAllMocks();
  const rows = await history(nats.store, subject, 'test');
  const original = rows[0]!;
  const clear = { action: 'clear', serverId: fixture.serverId, connectionId: 'installed',
    changeRef: 'later', expectedSequence: original.sequence };
  const next = later === 'clear' ? clear : { ...input, ...clear, action: 'select' };
  await changeConnectionSelection(nats.store, binding, 'alice', next);
  await waitForDuplicateWindow(nats);
  await app.close();
  const connection = await nats.client('command');
  const store = await createEventStore(connection);
  app = startApp(store);
  const noAppend = vi.spyOn(store, 'append');
  const noHead = vi.spyOn(store, 'head');
  const reads = vi.spyOn(store, 'readStream');
  try {
    const response = await get(receiptUrl(fixture, 'lost'));
    expect(response.statusCode).toBe(200);
    const expected = expectedReceipt(original, 'select', fixture.revision, fixture.profileId);
    expect(response.json()).toEqual(expected);
    const latest = await history(nats.store, subject, 'test');
    const last = latest.at(-1)!;
    const latestResponse = await get(receiptUrl(fixture, 'later'));
    const expectedLatest = expectedReceipt(last, later, fixture.revision, fixture.profileId);
    expect(latestResponse.json()).toEqual(expectedLatest);
    const current = await readConnectionSelection(nats.store, binding, 'alice', fixture.serverId);
    expect(current.status).toBe(later === 'clear' ? 'unavailable' : 'saved_unverified');
    expect(current.sequence).toBe(last.sequence);
    expect(noAppend).not.toHaveBeenCalled();
    expect(noHead).not.toHaveBeenCalled();
    function readSubject(call: unknown[]) {
      return call[0];
    }
    expect(reads.mock.calls.map(readSubject)).toEqual([
      subject, 'member-alice', 'ownership-test', subject, 'member-alice', 'ownership-test',
    ]);
  } finally {
    vi.restoreAllMocks();
    await app.close();
    app = startApp();
  }
}
it.each(['clear', 'select'])(
  'recovers each original choice after %s, a lost reply, restart and deduplication expiry',
  recoverOriginal);

async function chosen() {
  const fixture = await saved();
  const input = { action: 'select', serverId: fixture.serverId, connectionId: 'installed',
    profileId: fixture.profileId, profileRevision: fixture.revision,
    changeRef: fixture.changeRef, expectedSequence: 0 };
  await changeConnectionSelection(nats.store, binding, 'alice', input);
  const subject = `connection-selection-alice-${fixture.serverId}`;
  const rows = await history(nats.store, subject, 'test');
  return { ...fixture, subject, original: rows[0]! };
}
async function laterProfileChange(action: string) {
  const fixture = await chosen();
  function stage() {
    const identity = { reference: privateCanary, uid: privateCanary, resourceVersion: privateCanary };
    return Promise.resolve({ status: 'staged' as const, identity });
  }
  const custody = { stage: vi.fn(stage) };
  if (action === 'rotate') {
    const input = { action, serverId: fixture.serverId, profileId: fixture.profileId,
      connectionId: 'installed', changeRef: action, expectedSequence: fixture.revision,
      expectedGeneration: 1, appendUntil: Date.now() + 60_000 };
    await saveBearerConnection(nats.store, binding, 'alice', custody, input,
      material, pgDb(storage.queue));
  } else {
    const expectedSequence = action === 'disable' ? 0 : fixture.revision;
    const actor = action === 'disable' ? 'admin' : 'alice';
    const input = { action, userId: 'alice', serverId: fixture.serverId,
      profileId: fixture.profileId, changeRef: action, expectedSequence };
    await changePersonalConnection(nats.store, binding, actor, input);
  }
  custody.stage.mockClear();
  const before = await readConnectionSelection(nats.store, binding, 'alice', fixture.serverId);
  expect(before.status).toBe('unavailable');
  const revoked = envelope('test', grantStream('mcp_server', fixture.serverId), 'grant.revoked', {
    resourceType: 'mcp_server', resourceId: fixture.serverId, granteeKind: 'member',
    granteeId: 'alice', revokedBy: 'admin',
  });
  await nats.seed([revoked]);
  await memberAuthorisation(binding).handler.handle(revoked, pgDb(storage.queue));
  const response = await get(receiptUrl(fixture));
  const expected = expectedReceipt(fixture.original, 'select', fixture.revision, fixture.profileId);
  expect(response.json()).toEqual(expected);
  expect(custody.stage).not.toHaveBeenCalled();
  expect(await nats.store.head(fixture.subject)).toBe(before.sequence);
}
it.each(['rotate', 'revoke', 'disable'])(
  'keeps the original receipt after %s and tool grant loss without restoring selection',
  laterProfileChange);

async function isolation() {
  const fixture = await chosen();
  for (const member of ['bob', 'admin']) {
    expect((await get(receiptUrl(fixture), member)).json()).toEqual({ status: 'unknown' });
  }
  for (const url of [receiptUrl(fixture, 'missing'),
    receiptUrl(fixture).replace(fixture.serverId, 'different')]) {
    const response = await get(url);
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ status: 'unknown' });
  }
  for (const key of ['ownerId', 'userId', 'extra']) {
    expect((await get(`${receiptUrl(fixture)}?${key}=alice`, 'bob')).statusCode).toBe(400);
  }
  const malformed = receiptUrl(fixture).replace(fixture.serverId, 'bad%20id');
  expect((await get(malformed)).statusCode).toBe(400);
  const response = await app.inject({ url: receiptUrl(fixture), headers: headers(),
    payload: { ownerId: 'alice' } });
  expect(response.statusCode).toBe(400);
  expect(response.headers['cache-control']).toBe('no-store');
  const anonymous = await app.inject({ url: receiptUrl(fixture) });
  expect(anonymous.statusCode).toBe(401);
  expect(anonymous.headers['cache-control']).toBe('no-store');
  const foreign = await app.inject({ url: receiptUrl(fixture), headers: headers('alice', 'other') });
  expect(foreign.statusCode).toBe(403);
  expect(foreign.headers['cache-control']).toBe('no-store');
  const post = await app.inject({ method: 'POST', url: fixture.url, headers: headers() });
  expect(post.statusCode).toBe(403);
}
it('keeps choices private, treats missing as unknown and refuses extra input', isolation);

async function corrupted(kind: string) {
  const fixture = await chosen();
  const row = structuredClone(fixture.original);
  const event = row.event;
  const data = { userId: 'alice', serverId: fixture.serverId, connectionId: 'installed',
    expectedSequence: 0, action: 'select', profileId: fixture.profileId,
    profileRevision: fixture.revision };
  const eventPatches: Record<string, object> = {
    silo: { silo: 'foreign' }, source: { source: 'other' }, type: { type: 'connection.created' },
    principal: { principal: { kind: 'human', id: 'bob' } },
    principalKind: { principal: { kind: 'system', id: 'alice' } },
    id: { id: 'a'.repeat(64) }, reference: { commandId: 'other' },
    subject: { subject: 'connection-selection-alice-other' }, time: { time: privateCanary },
  };
  const dataPatches: Record<string, object> = {
    owner: { userId: 'bob' }, server: { serverId: 'other' },
    expectedSequence: { expectedSequence: 1 }, malformed: { profileRevision: 0 },
    legacy: { profileRevision: undefined }, extra: { label: privateCanary },
    clearProfile: { action: 'clear' },
  };
  Object.assign(event, eventPatches[kind]);
  event.data = { ...data, ...dataPatches[kind] };
  if (kind === 'position') {
    row.sequence = 0;
  }
  if (kind === 'foreignMember' || kind === 'foreignServer') {
    if (kind === 'foreignMember') {
      data.userId = 'bob';
    } else {
      data.serverId = 'another';
    }
    event.subject = `connection-selection-${data.userId}-${data.serverId}`;
    event.principal = { kind: 'human', id: data.userId };
    const hash = createHash('sha256');
    hash.update(JSON.stringify(['test', event.subject, event.commandId]));
    event.id = hash.digest('hex');
    event.data = data;
  }
  const read = nats.store.readStream.bind(nats.store);
  async function* changed(subject: string, from?: number, deadline?: number) {
    if (subject !== fixture.subject) {
      yield* read(subject, from, deadline);
      return;
    }
    if (kind === 'preceding') {
      const hash = createHash('sha256');
      hash.update(JSON.stringify(['test', event.subject, 'earlier']));
      const earlier = { ...event, commandId: 'earlier', id: hash.digest('hex') };
      yield { sequence: row.sequence - 1, event: earlier };
    }
    yield row;
    if (kind === 'duplicate') {
      yield row;
    }
    if (kind === 'conflicting') {
      const next = { ...data, expectedSequence: row.sequence };
      yield { sequence: row.sequence + 1, event: { ...event, data: next } };
    }
  }
  vi.spyOn(nats.store, 'readStream').mockImplementation(changed);
  try {
    const response = await get(receiptUrl(fixture));
    expect(response.statusCode).toBe(kind === 'silo' ? 503 : 404);
    expect(response.json()).toEqual({ status: kind === 'silo' ? 'unavailable' : 'unknown' });
  } finally {
    vi.restoreAllMocks();
  }
}
it.each(['silo', 'source', 'type', 'principal', 'principalKind', 'id', 'reference', 'subject',
  'time', 'owner', 'server', 'expectedSequence', 'malformed', 'legacy', 'extra', 'clearProfile',
  'position', 'duplicate', 'conflicting', 'foreignMember', 'foreignServer', 'preceding'])(
  'never confirms %s records or offers permission to resend', corrupted);

async function loading(outcome: string) {
  const fixture = await chosen();
  const read = nats.store.readStream.bind(nats.store);
  const subjects: string[] = [];
  let removed: ReturnType<typeof envelope> | undefined;
  async function* duringLoad(subject: string, from?: number, deadline?: number) {
    subjects.push(subject);
    if (subject === fixture.subject) {
      expect(deadline! - performance.now()).toBeGreaterThan(2_000);
      expect(deadline! - performance.now()).toBeLessThanOrEqual(10_000);
      if (outcome === 'slow') {
        await delay(2_100);
        await nats.seed([envelope('test', 'conversation-busy', 'conversation.closed',
          { conversationId: 'busy', closedBy: 'alice' })]);
      } else if (outcome !== 'failure') {
        removed = envelope('test', 'member-alice', 'member.removed',
          { memberId: 'alice', removedBy: 'admin' });
        await nats.seed([removed]);
      }
      if (outcome === 'failed' || outcome === 'failure') {
        throw new Error(privateCanary);
      }
      if (outcome === 'missing') {
        return;
      }
    }
    yield* read(subject, from, deadline);
  }
  vi.spyOn(nats.store, 'readStream').mockImplementation(duringLoad);
  try {
    // Allow the deliberate membership or chat append while checking this read.
    const response = await app.inject({ url: receiptUrl(fixture), headers: headers() });
    let expected = 403;
    if (outcome === 'slow') {
      expected = 200;
    }
    if (outcome === 'failure') {
      expected = 503;
    }
    expect(response.statusCode).toBe(expected);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).not.toContain(privateCanary);
    expect(logs.join('\n')).not.toContain(privateCanary);
    expect(subjects).toEqual([fixture.subject, 'member-alice', 'ownership-test']);
  } finally {
    vi.restoreAllMocks();
    if (removed) {
      await memberAuthorisation(binding).handler.handle(removed, pgDb(storage.queue));
    }
    await join('alice');
  }
}
it.each(['successful', 'missing', 'failed', 'failure', 'slow'])(
  'checks membership once after %s history; removal wins and busy chats preserve reads', loading);

async function invalidReaderInput(extra: object) {
  const input = { serverId: 'server', changeRef: 'change', ...extra };
  const position = await nats.store.head();
  await expect(readOwnSelectionChange(nats.store, binding, 'alice', input)).rejects.toThrow();
  expect(await nats.store.head()).toBe(position);
}
it.each([{ userId: 'bob' }, { profileId: 'other' }, { changeRef: 'bad ref' }])(
  'rejects extra or malformed direct reader input %j', invalidReaderInput);
