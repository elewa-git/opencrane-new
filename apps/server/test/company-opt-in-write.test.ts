import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { encodeSession } from '@opencrane/auth';
import { createStore, memberAuthorisation } from '@opencrane/authz';
import { databases, openfga } from '@opencrane/authz/testing';
import { jetstreamManager } from '@nats-io/jetstream';
import type { AppendCommand } from '@opencrane/event-store';
import { natsFixture } from '@opencrane/event-store/testing';
import { catalogueDigest } from '@opencrane/events/mcp-catalogue';
import { changeConnectionSelection, readConnectionSelection, envelope, history, mcpPolicy,
  parseMcpCall } from '@opencrane/models';
import { pgDb } from '@opencrane/projections';
import { buildServer } from '../src/server.ts';
import { testAuthConfig } from './support/test-auth-config.ts';

const config = testAuthConfig({ expectedOrgId: 'org-test' });
const canary = 'company-credential-canary';
const logs: string[] = [];
let nats: Awaited<ReturnType<typeof natsFixture>>;
let fga: Awaited<ReturnType<typeof openfga>>;
let storage: Awaited<ReturnType<typeof databases>>;
let binding: Awaited<ReturnType<typeof createStore>>;
let app: ReturnType<typeof buildServer>;
function write(line: string) {
  logs.push(line);
}
function memberId(_silo: string, _issuer: string, subject: string) {
  return Promise.resolve(subject === 'unmapped' ? undefined : subject);
}
function emptyCatalogue(): never {
  throw new Error(canary);
}
function server(currentBinding = binding, lookup = memberId) {
  const catalogue = { rows: emptyCatalogue, tools: emptyCatalogue };
  const integrations = { silo: 'test', store: nats.store, binding: currentBinding,
    feed: { memberId: lookup }, catalogue };
  return buildServer(config, { integrations, logDestination: { write } });
}
async function join(memberId: string, role: string) {
  const event = envelope('test', `member-${memberId}`, 'member.joined', {
    memberId, role, email: `${memberId}@example.test`, displayName: canary,
  });
  await nats.seed([event]);
  await memberAuthorisation(binding).handler.handle(event, pgDb(storage.queue));
}
async function initialise() {
  vi.stubEnv('LOG_LEVEL', 'info');
  nats = await natsFixture();
  fga = await openfga();
  storage = await databases();
  binding = await createStore(fga.apiUrl, 'test');
  await join('owner', 'owner');
  await join('admin', 'admin');
  await join('ordinary', 'member');
  app = server();
}
async function close() {
  await app?.close();
  await storage?.close();
  await fga?.close();
  await nats?.close();
  vi.unstubAllEnvs();
}
beforeAll(initialise, 120_000);
afterAll(close);
function restore() {
  vi.restoreAllMocks();
  expect(logs.join('\n')).not.toContain(canary);
}
afterEach(restore);
function headers(memberId = 'admin', orgId = 'org-test') {
  const now = Math.floor(Date.now() / 1000);
  const session = { sub: memberId, orgId, roles: ['owner'], authTime: now, exp: now + 60 };
  return { origin: new URL(config.redirectUri).origin, cookie: `${config.cookieName}=${encodeSession(config, session)}` };
}
async function fixture() {
  const serverId = randomUUID();
  const subject = `mcp-${serverId}`;
  const registration = envelope('test', subject, 'mcp.server_registered', {
    serverId, kind: 'remote', locator: 'https://example.test/mcp', registeredBy: 'admin',
  });
  await nats.seed([registration]);
  const registrationRevision = await nats.store.head(subject);
  const discovery = envelope('test', subject, 'mcp.server_discovered', {
    serverId, connectionId: 'installed', accountMode: 'company', tools: [], toolCount: 0,
    schemaDigest: catalogueDigest([]),
  });
  await nats.seed([discovery]);
  const choice = { connectionId: 'installed', registrationRevision,
    enabled: true, expectedSequence: 0, changeRef: 'enable' };
  const url = `/api/org/integrations/${serverId}/company-opt-in`;
  return { serverId, subject, registration, discovery, choice, url };
}
function checked(response: Awaited<ReturnType<typeof app.inject>>, code: number) {
  expect(response.statusCode).toBe(code);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.body).not.toContain(canary);
  return response.json<unknown>();
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function post(test: Fixture, payload: unknown = test.choice, member = 'admin') {
  return app.inject({ method: 'POST', url: test.url, headers: headers(member), payload });
}
async function read(test: Fixture) {
  const response = await app.inject({ url: test.url, headers: headers() });
  return checked(response, 200);
}
async function currentAdmin(member: string) {
  const test = await fixture();
  const before = await nats.store.head();
  const saved = await post(test, test.choice, member);
  const receipt = { enabled: true, sequence: before + 1, changeRef: 'enable' };
  expect(checked(saved, 200)).toEqual(receipt);
  expect(await read(test)).toMatchObject({ enabled: true, sequence: receipt.sequence });
  const removal = { ...test.choice, enabled: false,
    expectedSequence: receipt.sequence, changeRef: 'remove' };
  const removed = await post(test, removal, member);
  expect(checked(removed, 200)).toEqual({ ...receipt, enabled: false,
    sequence: before + 2, changeRef: 'remove' });
  await app.close();
  app = server();
  expect(await read(test)).toMatchObject({ enabled: false, sequence: before + 2 });
  expect(checked(await post(test, test.choice, member), 200)).toEqual(receipt);
  expect(await nats.store.head()).toBe(before + 2);
  const rows = await history(nats.store, `connection-company-${test.serverId}`, 'test');
  expect(rows).toHaveLength(2);
  expect(rows[0]?.event.principal).toEqual({ kind: 'human', id: member });
  expect(JSON.stringify(rows)).not.toContain(canary);
}
it.each(['owner', 'admin'])('lets a current %s enable and remove, then replay the original receipt',
  currentAdmin);

async function refusedMember(kind: string) {
  const test = await fixture();
  let member = kind;
  let org = 'org-test';
  if (kind === 'foreign') {
    member = 'admin';
    org = 'other-org';
  }
  if (kind === 'removed') {
    member = randomUUID();
    await join(member, 'admin');
    const event = envelope('test', `member-${member}`, 'member.removed', {
      memberId: member, removedBy: 'owner',
    });
    await nats.seed([event]);
  }
  const before = await nats.store.head();
  const response = await app.inject({ method: 'POST', url: test.url,
    headers: headers(member, org), payload: test.choice });
  checked(response, 403);
  expect(await nats.store.head()).toBe(before);
}
it.each(['ordinary', 'removed', 'foreign', 'unmapped'])('refuses %s members', refusedMember);

async function invalidRequest(kind: string) {
  const test = await fixture();
  const requestHeaders: Record<string, string> = { ...headers(), 'content-type': 'application/json' };
  let payload: unknown = test.choice;
  let url = test.url;
  let code = 400;
  if (kind === 'missing origin') {
    delete requestHeaders.origin;
    code = 403;
  } else if (kind === 'foreign origin') {
    requestHeaders.origin = `${requestHeaders.origin}.foreign`;
    code = 403;
  } else if (kind === 'malformed') {
    payload = `{"enabled":${canary}`;
  } else if (kind === 'oversized') {
    payload = JSON.stringify({ ...test.choice, extra: canary.repeat(500) });
  } else if (kind === 'text') {
    requestHeaders['content-type'] = 'text/plain';
    payload = JSON.stringify(test.choice);
  } else if (kind === 'query') {
    url += `?memberId=${canary}`;
  } else if (kind === 'invalid path') {
    url = '/api/org/integrations/invalid.id/company-opt-in';
  } else {
    payload = { ...test.choice, [kind]: canary };
  }
  const before = await nats.store.head();
  const response = await app.inject({ method: 'POST', url, headers: requestHeaders, payload });
  checked(response, code);
  expect(await nats.store.head()).toBe(before);
}
it.each(['missing origin', 'foreign origin', 'malformed', 'oversized', 'text', 'query',
  'invalid path', 'actorId', 'memberId', 'silo', 'siloId', 'serverId', 'changedBy', 'extra',
  'enabled', 'expectedSequence', 'connectionId', 'registrationRevision', 'changeRef'])(
  'rejects %s without saving', invalidRequest);

async function staleChoice(kind: string) {
  const test = await fixture();
  const saved = await post(test);
  checked(saved, 200);
  const receipt = saved.json<{ sequence: number }>();
  const next = { ...test.choice, expectedSequence: receipt.sequence, changeRef: 'next' };
  if (kind === 'control') {
    next.expectedSequence = 0;
  } else {
    await nats.seed([{ ...test.registration, id: randomUUID() },
      { ...test.discovery, id: randomUUID() }]);
    expect(await read(test)).toMatchObject({ enabled: false, sequence: receipt.sequence,
      connectionId: 'installed' });
  }
  const before = await nats.store.head();
  expect(checked(await post(test, next), 409)).toEqual({ status: 'conflict' });
  expect(await nats.store.head()).toBe(before);
}
it.each(['control', 'registration'])('refuses stale %s positions', staleChoice);

async function race(kind: string) {
  const test = await fixture();
  const member = randomUUID();
  await join(member, 'admin');
  const append = nats.store.append.bind(nats.store);
  async function beforeAppend(command: AppendCommand) {
    fault.mockRestore();
    if (kind === 'demotion') {
      const event = envelope('test', `member-${member}`, 'member.role_changed', {
        memberId: member, previousRole: 'admin', newRole: 'member', changedBy: 'owner',
      });
      await nats.seed([event]);
    } else {
      await nats.seed([{ ...test.registration, id: randomUUID() }]);
    }
    return append(command);
  }
  const fault = vi.spyOn(nats.store, 'append');
  fault.mockImplementationOnce(beforeAppend);
  const response = await post(test, test.choice, member);
  let code = 409;
  if (kind === 'demotion') {
    code = 503;
  }
  checked(response, code);
  expect(await nats.store.head(`connection-company-${test.serverId}`)).toBe(0);
}
it.each(['demotion', 'registration'])('refuses a racing %s before append', race);

async function lostReply() {
  const test = await fixture();
  const manager = await jetstreamManager(nats.connection);
  await manager.streams.update('EVENTS', { duplicate_window: 1_000_000_000 });
  const before = await nats.store.head();
  const append = nats.store.append.bind(nats.store);
  async function loseReply(command: AppendCommand) {
    await append(command);
    return { status: 'unavailable' as const, cause: new Error(canary) };
  }
  const fault = vi.spyOn(nats.store, 'append');
  fault.mockImplementationOnce(loseReply);
  expect(checked(await post(test), 503)).toEqual({ status: 'unavailable' });
  fault.mockRestore();
  await delay(1100);
  const receipt = { enabled: true, sequence: before + 1, changeRef: 'enable' };
  expect(checked(await post(test), 200)).toEqual(receipt);
  expect(checked(await post(test), 200)).toEqual(receipt);
  expect(checked(await post(test, { ...test.choice, enabled: false }), 409))
    .toEqual({ status: 'conflict' });
  expect(await nats.store.head()).toBe(before + 1);
}
it('recovers one receipt after a lost reply and broker deduplication expiry', lostReply);

async function preparation(kind: string) {
  const test = await fixture();
  const originalRead = nats.store.readStream.bind(nats.store);
  async function* readHistory(subject: string, from?: number, deadline?: number) {
    if (subject === test.subject) {
      if (kind === 'failed') {
        throw new Error(canary);
      }
      await delay(2100);
    }
    yield* originalRead(subject, from, deadline);
  }
  const fault = vi.spyOn(nats.store, 'readStream');
  fault.mockImplementation(readHistory);
  const response = await post(test);
  if (kind === 'failed') {
    expect(checked(response, 503)).toEqual({ status: 'unavailable' });
  } else {
    checked(response, 200);
  }
}
it.each(['slow', 'failed'])('keeps %s history outside the write deadline and errors private',
  preparation);

async function noAccountUse() {
  const test = await fixture();
  checked(await post(test), 200);
  const before = await nats.store.head();
  expect(await readConnectionSelection(nats.store, binding, 'admin', test.serverId))
    .toEqual({ status: 'unavailable', sequence: 0 });
  const selection = { action: 'select', serverId: test.serverId, connectionId: 'installed',
    profileId: 'company', profileRevision: 1, expectedSequence: 0, changeRef: 'select' };
  await expect(changeConnectionSelection(nats.store, binding, 'admin', selection)).rejects.toThrow();
  const metadata = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientCapabilities': {}, threadId: 'thread', callId: 'call' };
  const request = { jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'example', arguments: {}, _meta: metadata } };
  const parsed = parseMcpCall(JSON.stringify(request));
  const callHeaders = { 'mcp-protocol-version': '2026-07-28',
    'mcp-method': 'tools/call', 'mcp-name': 'example' };
  await expect(mcpPolicy(nats.store, 'test', test.serverId, 'installed', parsed, callHeaders))
    .rejects.toThrow('MCP context unavailable');
  expect(await nats.store.head()).toBe(before);
}
it('grants no tool use or company selection after an HTTP opt-in', noAccountUse);

async function unavailable(kind: string) {
  const test = await fixture();
  function failedLookup(): ReturnType<typeof memberId> {
    throw new Error(canary);
  }
  let current = server();
  let requestHeaders: Record<string, string> = headers();
  let code = 503;
  if (kind === 'anonymous') {
    requestHeaders = {};
    code = 401;
  } else if (kind === 'lookup') {
    await current.close();
    current = server(binding, failedLookup);
  } else if (kind === 'permissions') {
    await current.close();
    current = server({ ...binding, apiUrl: 'http://127.0.0.1:1' });
  } else {
    await current.close();
    current = buildServer(config);
  }
  const before = await nats.store.head();
  try {
    const response = await current.inject({ method: 'POST', url: test.url,
      headers: requestHeaders, payload: test.choice });
    checked(response, code);
    expect(await nats.store.head()).toBe(before);
  } finally {
    await current.close();
  }
}
it.each(['anonymous', 'lookup', 'permissions', 'configuration'])(
  'keeps %s failures uncached and private', unavailable);
