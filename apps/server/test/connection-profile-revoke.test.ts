import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { encodeSession } from '@opencrane/auth';
import { createStore, memberAuthorisation } from '@opencrane/authz';
import { databases, openfga } from '@opencrane/authz/testing';
import { envelope, history, foldConnection } from '@opencrane/models';
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
  const url = `/api/my/tools/${serverId}/profiles/${profileId}`;
  return { serverId, profileId, subject, event, data, revision, url, changeRef };
}
function revoke(fixture: Awaited<ReturnType<typeof saved>>) {
  return { changeRef: 'revoke', expectedSequence: fixture.revision };
}
function privateOutput(response: { body: string; headers: Record<string, unknown> }) {
  expect(response.headers['cache-control']).toBe('no-store');
  for (const canary of [privateCanary, material]) {
    expect(response.body).not.toContain(canary);
    expect(logs.join('\n')).not.toContain(canary);
  }
}
async function post(url: string, payload: object | string, requestHeaders = headers()) {
  const response = await app.inject({ method: 'POST', url: `${url}/revoke`, payload,
    headers: requestHeaders });
  privateOutput(response);
  return response;
}
async function get(url: string) {
  const response = await app.inject({ url, headers: headers() });
  privateOutput(response);
  return response;
}
async function recover(lost: boolean) {
  const fixture = await saved();
  const input = revoke(fixture);
  const append = nats.store.append.bind(nats.store);
  async function loseReply(command: Parameters<typeof append>[0]): Promise<never> {
    await append(command);
    throw new Error(`${privateCanary} ${material}`);
  }
  const writes = vi.spyOn(nats.store, 'append');
  if (lost) {
    writes.mockImplementationOnce(loseReply);
  }
  const response = await post(fixture.url, input);
  expect(response.statusCode).toBe(lost ? 503 : 200);
  expect(writes).toHaveBeenCalledTimes(1);
  vi.restoreAllMocks();
  await waitForDuplicateWindow(nats);
  await app.close();
  app = startApp();
  const position = await nats.store.head();
  const noAppend = vi.spyOn(nats.store, 'append');
  const noCustody = vi.spyOn(custody, 'connectionCustody');
  const provider = vi.spyOn(globalThis, 'fetch');
  try {
    const receipt = await get(`${fixture.url}/changes/revoke`);
    expect(receipt.statusCode).toBe(200);
    expect(receipt.json()).toMatchObject({ status: 'confirmed', action: 'revoke',
      changeRef: 'revoke', eventType: 'connection.revoked', generation: null });
    const original = { status: 'revoked', sequence: receipt.json().sequence, changeRef: 'revoke' };
    if (!lost) {
      expect(response.json()).toEqual(original);
    }
    const retry = await post(fixture.url, input);
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toEqual(original);
    const changed = { ...input, expectedSequence: original.sequence };
    expect((await post(fixture.url, changed)).statusCode).toBe(503);
    const stale = { ...input, changeRef: 'another' };
    expect((await post(fixture.url, stale)).statusCode).toBe(503);
    const missing = await get(`${fixture.url}/changes/missing`);
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ status: 'unknown' });
    const rows = await history(nats.store, fixture.subject, 'test');
    expect(rows).toHaveLength(2);
    expect(rows[1]!.event.data).toEqual({ userId: 'alice', serverId: fixture.serverId,
      profile: fixture.profileId, expectedSequence: fixture.revision,
      revokedBy: 'alice', reason: 'owner_requested' });
    expect(JSON.stringify(rows)).not.toContain(material);
    expect(foldConnection(rows).status).toBe('unavailable');
    expect(noAppend).not.toHaveBeenCalled();
    expect(noCustody).not.toHaveBeenCalled();
    // Allow only the existing permission service calls.
    for (const [url] of provider.mock.calls) {
      expect(String(url).startsWith(fga.apiUrl)).toBe(true);
    }
    expect(await nats.store.head()).toBe(position);
  } finally {
    vi.restoreAllMocks();
  }
}
it.each([false, true])('revokes once and recovers beyond deduplication (lost reply: %s)', recover);

async function invalidInput(patch: object) {
  const fixture = await saved();
  const position = await nats.store.head();
  const response = await post(fixture.url, { ...revoke(fixture), ...patch });
  expect(response.statusCode).toBe(400);
  expect(response.json()).toEqual({ status: 'refused' });
  expect(await nats.store.head()).toBe(position);
}
it.each([{ userId: 'alice' }, { ownerId: 'alice' }, { action: 'revoke' },
  { action: 'disable' }, { silo: 'test' }, { profileId: 'other' }, { serverId: 'other' },
  { extra: material }, { changeRef: '' }, { changeRef: 'bad ref' },
  { changeRef: 'x'.repeat(201) }, { expectedSequence: -1 }, { expectedSequence: 0.5 }])(
  'refuses supplied identity or invalid input %j without an append', invalidInput);

async function boundaries() {
  const fixture = await saved();
  const input = revoke(fixture);
  const position = await nats.store.head();
  expect((await post(fixture.url, input, { ...headers(), cookie: '' })).statusCode).toBe(401);
  expect((await post(fixture.url, input, headers('alice', 'foreign'))).statusCode).toBe(403);
  for (const origin of ['', 'https://foreign.test', `${headers().origin}/`]) {
    expect((await post(fixture.url, input, { ...headers(), origin })).statusCode).toBe(403);
  }
  for (const member of ['bob', 'admin']) {
    expect((await post(fixture.url, input, headers(member))).statusCode).toBe(503);
    expect((await post(fixture.url, { ...input, userId: 'alice' }, headers(member)))
      .statusCode).toBe(400);
  }
  for (const id of ['bad%20id', 'x'.repeat(201)]) {
    expect((await post(fixture.url.replace(fixture.profileId, id), input)).statusCode).toBe(400);
  }
  const query = await app.inject({ method: 'POST', url: `${fixture.url}/revoke?extra=value`,
    payload: input, headers: headers() });
  privateOutput(query);
  expect(query.statusCode).toBe(400);
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
it('requires a session, matching organisation and silo, exact Origin and bounded JSON', boundaries);

async function invalidHistory(kind: string) {
  const fixture = await saved();
  const read = nats.store.readStream.bind(nats.store);
  async function* replace(subject: string, from?: number, deadline?: number) {
    for await (const row of read(subject, from, deadline)) {
      if (subject === fixture.subject) {
        const data = structuredClone(fixture.data);
        if (kind === 'legacy') {
          row.event.data = { userId: 'alice', serverId: fixture.serverId,
            profile: fixture.profileId, secretRef: data.secretRef };
        } else if (kind === 'silo') {
          row.event.silo = 'foreign';
        } else {
          data.activation.ownerKind = kind;
          data.activation.purpose = kind;
          row.event.data = data;
        }
      }
      yield row;
    }
  }
  vi.spyOn(nats.store, 'readStream').mockImplementation(replace);
  const position = await nats.store.head();
  try {
    const response = await post(fixture.url, revoke(fixture));
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'unavailable' });
    expect(await nats.store.head()).toBe(position);
  } finally {
    vi.restoreAllMocks();
  }
}
it.each(['legacy', 'company', 'validation', 'silo'])(
  'refuses %s records without an append', invalidHistory);

async function loading(outcome: string) {
  const fixture = await saved();
  const read = nats.store.readStream.bind(nats.store);
  let removed: ReturnType<typeof envelope> | undefined;
  let prepared = false;
  async function* duringLoad(subject: string, from?: number, deadline?: number) {
    expect(subject).not.toMatch(/^conversation-/u);
    if (subject === fixture.subject) {
      prepared = true;
      expect(deadline! - performance.now()).toBeGreaterThan(2_000);
      if (outcome === 'slow') {
        await delay(2_100);
        const activity = envelope('test', 'conversation-busy', 'conversation.closed',
          { conversationId: 'busy', closedBy: 'alice' });
        await nats.seed([activity]);
      } else if (outcome !== 'failure') {
        removed = envelope('test', 'member-alice', 'member.removed',
          { memberId: 'alice', removedBy: 'admin' });
        await nats.seed([removed]);
      }
      if (outcome === 'failed' || outcome === 'failure') {
        throw new Error(`${privateCanary} ${material}`);
      }
      if (outcome === 'missing') {
        return;
      }
    }
    yield* read(subject, from, deadline);
  }
  vi.spyOn(nats.store, 'readStream').mockImplementation(duringLoad);
  const append = nats.store.append.bind(nats.store);
  async function checked(command: Parameters<typeof append>[0]) {
    expect(prepared).toBe(true);
    expect(command.expectedSequence).toBe(fixture.revision);
    expect(command.deadline! - performance.now()).toBeLessThanOrEqual(2_000);
    return append(command);
  }
  const writes = vi.spyOn(nats.store, 'append').mockImplementation(checked);
  try {
    const response = await post(fixture.url, revoke(fixture));
    let expected = 403;
    if (outcome === 'slow') expected = 200;
    if (outcome === 'failure') expected = 503;
    expect(response.statusCode).toBe(expected);
    expect(writes).toHaveBeenCalledTimes(outcome === 'slow' ? 1 : 0);
  } finally {
    vi.restoreAllMocks();
    expect(await nats.store.head(fixture.subject) > fixture.revision).toBe(outcome === 'slow');
    if (removed) {
      await memberAuthorisation(binding).handler.handle(removed, pgDb(storage.queue));
      await join('alice');
    }
  }
}
it.each(['successful', 'missing', 'failed', 'failure', 'slow'])(
  'checks current membership after %s history and hides dependency details', loading);
