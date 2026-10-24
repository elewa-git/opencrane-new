import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createEventStore, type StoredEvent } from '@opencrane/event-store';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { encodeSession } from '@opencrane/auth';
import { createStore, memberAuthorisation } from '@opencrane/authz';
import { databases, openfga } from '@opencrane/authz/testing';
import { catalogueDigest } from '@opencrane/events/mcp-catalogue';
import { envelope, saveBearerConnection, history } from '@opencrane/models';
import { changePersonalConnection } from '../../../libs/models/src/bearer-connections.ts';
import { pgDb, type Db } from '@opencrane/projections';
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
async function saved(serverId = `server${counter + 1}`, changeRef = `save${counter + 1}`) {
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
  const url = `/api/my/tools/${serverId}/profiles/${profileId}`;
  return { serverId, profileId, subject, event, data, revision, url, changeRef };
}
function receiptUrl(fixture: Awaited<ReturnType<typeof saved>>, changeRef = fixture.changeRef) {
  return `${fixture.url}/changes/${changeRef}`;
}
async function get(url: string, member = 'alice') {
  const response = await app.inject({ url, headers: headers(member) });
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.body).not.toContain(privateCanary);
  expect(response.body).not.toContain(material);
  expect(logs.join('\n')).not.toContain(privateCanary);
  expect(logs.join('\n')).not.toContain(material);
  return response;
}
function expectedReceipt(row: StoredEvent, action = 'create', generation: number | null = 1) {
  return { status: 'confirmed', changeRef: row.event.commandId,
    eventId: row.event.id, eventType: row.event.type, recordedAt: row.event.time,
    sequence: row.sequence, action, generation, identityStatus: 'unverified' };
}
async function recoverOriginal(later: string) {
  const fixture = await saved();
  const input = { action: 'rotate', serverId: fixture.serverId, connectionId: 'installed',
    profileId: fixture.profileId, changeRef: 'lost', expectedSequence: fixture.revision,
    expectedGeneration: 1, appendUntil: Date.now() + 60_000 };
  function stage() {
    const identity = { reference: privateCanary, uid: privateCanary, resourceVersion: privateCanary };
    return Promise.resolve({ status: 'staged' as const, identity });
  }
  const custody = { stage: vi.fn(stage) };
  const database = pgDb(storage.queue);
  function waitForLock<Result>(name: string, work: (db: Db) => Promise<Result>) {
    // Wait for the fixture lock so a busy host cannot replace the lost-reply check.
    return database.lock!(name, work);
  }
  const coordination = { lock: waitForLock };
  async function save() {
    return saveBearerConnection(nats.store, binding, 'alice', custody, input,
      material, coordination);
  }
  const append = nats.store.append.bind(nats.store);
  async function loseReply(command: Parameters<typeof append>[0]): Promise<never> {
    await append(command);
    throw new Error('Lost reply');
  }
  vi.spyOn(nats.store, 'append').mockImplementationOnce(loseReply);
  await expect(save()).rejects.toThrow('Lost reply');
  vi.restoreAllMocks();
  const rows = await history(nats.store, fixture.subject, 'test');
  expect(JSON.stringify(rows)).not.toContain(material);
  const original = rows[1]!;
  if (later === 'rotate') {
    input.changeRef = 'later';
    input.expectedSequence = original.sequence;
    input.expectedGeneration = 2;
    await save();
  } else {
    const revoke = { action: 'revoke', userId: 'alice', serverId: fixture.serverId,
      profileId: fixture.profileId, changeRef: 'later', expectedSequence: original.sequence };
    await changePersonalConnection(nats.store, binding, 'alice', revoke);
  }
  await waitForDuplicateWindow(nats);
  await app.close();
  const connection = await nats.client('command');
  const store = await createEventStore(connection);
  app = startApp(store);
  const noAppend = vi.spyOn(store, 'append');
  const noHead = vi.spyOn(store, 'head');
  const reads = vi.spyOn(store, 'readStream');
  custody.stage.mockClear();
  try {
    const response = await get(receiptUrl(fixture, 'lost'));
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(expectedReceipt(original, 'rotate', 2));
    const latest = await history(nats.store, fixture.subject, 'test');
    const last = latest.at(-1)!;
    const latestResponse = await get(receiptUrl(fixture, 'later'));
    expect(latestResponse.json()).toEqual(expectedReceipt(last, later,
      later === 'rotate' ? 3 : null));
    expect(noAppend).not.toHaveBeenCalled();
    expect(noHead).not.toHaveBeenCalled();
    expect(custody.stage).not.toHaveBeenCalled();
    function subject(call: unknown[]) {
      return call[0];
    }
    expect(reads.mock.calls.map(subject)).toEqual([
      fixture.subject, 'member-alice', 'ownership-test',
      fixture.subject, 'member-alice', 'ownership-test',
    ]);
  } finally {
    vi.restoreAllMocks();
    await app.close();
    app = startApp();
  }
}
it.each(['rotate', 'revoke'])(
  'recovers the original lost save after %s, reader restart and deduplication expiry', recoverOriginal);

async function isolation() {
  const fixture = await saved();
  const response = await get(receiptUrl(fixture));
  const rows = await history(nats.store, fixture.subject, 'test');
  expect(response.json()).toEqual(expectedReceipt(rows[0]!));
  await saved(fixture.serverId, fixture.changeRef);
  await saved('another-server', fixture.changeRef);
  for (const member of ['bob', 'admin']) {
    expect((await get(receiptUrl(fixture), member)).json()).toEqual({ status: 'unknown' });
  }
  for (const url of [receiptUrl(fixture, 'missing'),
    receiptUrl(fixture).replace(fixture.profileId, 'different'),
    receiptUrl(fixture).replace(fixture.serverId, 'different')]) {
    expect((await get(url)).json()).toEqual({ status: 'unknown' });
  }
  for (const key of ['ownerId', 'userId', 'extra']) {
    const refused = await get(`${receiptUrl(fixture)}?${key}=alice`, 'bob');
    expect(refused.statusCode).toBe(400);
  }
  const body = await app.inject({ method: 'GET', url: receiptUrl(fixture),
    headers: { ...headers(), 'content-type': 'application/json' }, payload: { ownerId: 'alice' } });
  expect(body.statusCode).toBe(400);
  expect(body.headers['cache-control']).toBe('no-store');
}
it('keeps exact receipts private and refuses owner spoofing and extra input', isolation);

async function corrupted(kind: string) {
  const fixture = await saved();
  const read = nats.store.readStream.bind(nats.store);
  async function* changed(subject: string, from?: number, deadline?: number) {
    for await (const row of read(subject, from, deadline)) {
      if (subject !== fixture.subject) {
        yield row;
        continue;
      }
      const event = structuredClone(row.event);
      const data = structuredClone(fixture.data);
      if (kind === 'source') {
        event.source = 'other';
      }
      if (kind === 'principal') event.principal = { kind: 'human', id: 'bob' };
      if (kind === 'type') {
        event.type = 'connection.refreshed';
      }
      if (kind === 'hash') {
        event.id = 'wrong';
      }
      if (kind === 'reference') {
        event.commandId = 'wrong';
      }
      if (kind === 'subject') {
        event.subject = 'connection-alice-other-profile';
      }
      if (kind === 'owner') {
        data.userId = 'bob';
      }
      if (kind === 'server') {
        data.serverId = 'other';
      }
      if (kind === 'profile') {
        data.profile = 'other';
      }
      if (kind === 'activation') {
        data.activation.operationId = 'wrong';
      }
      if (kind === 'malformed') {
        data.activation.uid = '';
      }
      if (kind === 'changedBy') {
        data.activation.changedBy = 'bob';
      }
      if (kind === 'expectedSequence') {
        data.activation.expectedSequence = 123;
      }
      if (kind === 'generation') {
        data.activation.generation = 2;
      }
      if (kind === 'time') {
        event.time = privateCanary;
      }
      if (kind === 'position') {
        row.sequence = 0;
      }
      if (kind === 'principalKind') event.principal = { kind: 'system', id: 'alice' };
      event.data = data;
      if (kind === 'closed' || kind === 'closureConflict') {
        event.type = 'connection.operation_closed';
        event.data = { userId: 'alice', serverId: fixture.serverId, profile: fixture.profileId,
          operationId: event.id, generation: 1, expectedSequence: 0,
          appendUntil: 1, reason: 'append_deadline_passed' };
      }
      if (kind === 'closureConflict' || kind === 'activationConflict') {
        yield row;
        event.id = 'other';
        event.commandId = 'other';
      }
      yield { ...row, event };
      if (kind === 'conflicting') {
        yield { sequence: row.sequence + 1, event: { ...event, id: 'other' } };
      }
    }
  }
  vi.spyOn(nats.store, 'readStream').mockImplementation(changed);
  try {
    const response = await get(receiptUrl(fixture));
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ status: 'unknown' });
  } finally {
    vi.restoreAllMocks();
  }
}
it.each(['source', 'principal', 'type', 'hash', 'reference', 'subject', 'owner', 'server',
  'profile', 'activation', 'malformed', 'closed', 'conflicting', 'changedBy',
  'expectedSequence', 'generation', 'time', 'position', 'principalKind',
  'closureConflict', 'activationConflict'])(
  'never confirms %s records or offers permission to resend', corrupted);

async function loading(outcome: string) {
  const fixture = await saved();
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
    const response = await get(receiptUrl(fixture));
    let expected = 403;
    if (outcome === 'slow') {
      expected = 200;
    }
    if (outcome === 'failure') {
      expected = 503;
    }
    expect(response.statusCode).toBe(expected);
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
  'checks membership once after %s history; removal wins and busy chats do not interfere', loading);

async function invalidRevoke(field: string) {
  const fixture = await saved();
  const input = { action: 'revoke', userId: 'alice', serverId: fixture.serverId,
    profileId: fixture.profileId, changeRef: 'revoked', expectedSequence: fixture.revision };
  await changePersonalConnection(nats.store, binding, 'alice', input);
  const read = nats.store.readStream.bind(nats.store);
  async function* altered(subject: string, from?: number, deadline?: number) {
    for await (const row of read(subject, from, deadline)) {
      if (subject === fixture.subject && row.event.commandId === 'revoked') {
        const data = { userId: 'alice', serverId: fixture.serverId, profile: fixture.profileId,
          revokedBy: 'alice', reason: 'owner_requested', expectedSequence: fixture.revision,
          [field]: 'wrong' };
        yield { ...row, event: { ...row.event, data } };
      } else {
        yield row;
      }
    }
  }
  vi.spyOn(nats.store, 'readStream').mockImplementation(altered);
  try {
    expect((await get(receiptUrl(fixture, 'revoked'))).json()).toEqual({ status: 'unknown' });
  } finally {
    vi.restoreAllMocks();
  }
}
it.each(['revokedBy', 'reason', 'expectedSequence'])(
  'refuses owner revocation with invalid %s', invalidRevoke);
