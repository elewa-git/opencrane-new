import { createHash } from 'node:crypto';
import { createEventStore, type StoredEvent } from '@opencrane/event-store';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { encodeSession } from '@opencrane/auth';
import { createStore, grantStream, memberAuthorisation } from '@opencrane/authz';
import { databases, openfga } from '@opencrane/authz/testing';
import { catalogueDigest } from '@opencrane/events/mcp-catalogue';
import { envelope, history } from '@opencrane/models';
import { changeConnectionSelection }
  from '../../../libs/models/src/connection-selection.ts';
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
  const grant = envelope('test', grantStream('mcp_server', serverId), 'grant.given', {
    resourceType: 'mcp_server', resourceId: serverId, granteeKind: 'member',
    granteeId: 'alice', grantedBy: 'admin',
  });
  await nats.seed([grant]);
  await memberAuthorisation(binding).handler.handle(grant, pgDb(storage.queue));
  const url = `/api/my/tools/${serverId}/selection`;
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
