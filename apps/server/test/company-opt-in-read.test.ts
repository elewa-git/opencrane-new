import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { encodeSession } from '@opencrane/auth';
import { createStore, memberAuthorisation } from '@opencrane/authz';
import { databases, openfga } from '@opencrane/authz/testing';
import { natsFixture } from '@opencrane/event-store/testing';
import { catalogueDigest } from '@opencrane/events/mcp-catalogue';
import { changeCompanyOptIn, envelope } from '@opencrane/models';
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
  return { cookie: `${config.cookieName}=${encodeSession(config, session)}` };
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
  const choice = { serverId, connectionId: 'installed', registrationRevision,
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
async function currentState(member: string) {
  const test = await fixture();
  const expected = { enabled: false, sequence: 0, connectionId: 'installed',
    registrationRevision: test.choice.registrationRevision };
  const absent = await app.inject({ url: test.url, headers: headers(member) });
  expect(checked(absent, 200)).toEqual(expected);
  const saved = await changeCompanyOptIn(nats.store, binding, member, test.choice);
  const enabled = await app.inject({ url: test.url, headers: headers(member) });
  expect(checked(enabled, 200)).toEqual({ ...expected, enabled: true, sequence: saved.sequence });
  const removal = { ...test.choice, enabled: false,
    expectedSequence: saved.sequence, changeRef: 'remove' };
  const removed = await changeCompanyOptIn(nats.store, binding, member, removal);
  const response = await app.inject({ url: test.url, headers: headers(member) });
  expect(checked(response, 200)).toEqual({ ...expected, sequence: removed.sequence });
}
it.each(['owner', 'admin'])('lets a current %s read absent, enabled and removed opt-in', currentState);

async function refused(kind: string) {
  const test = await fixture();
  await changeCompanyOptIn(nats.store, binding, 'admin', test.choice);
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
  const responses: unknown[] = [];
  for (const url of [test.url, '/api/org/integrations/missing/company-opt-in']) {
    const response = await app.inject({ url, headers: headers(member, org) });
    responses.push(checked(response, 403));
    expect(response.body).not.toMatch(/installed|enabled|sequence|registrationRevision/u);
  }
  expect(responses[0]).toEqual(responses[1]);
}
it.each(['ordinary', 'removed', 'foreign', 'unmapped'])(
  'reveals no server or opt-in facts to %s members', refused);

async function overrides(field: string) {
  const test = await fixture();
  const url = `${test.url}?${field}=${canary}`;
  const query = await app.inject({ url, headers: headers() });
  expect(checked(query, 400)).toEqual({ status: 'invalid_request' });
  const body = await app.inject({ url: test.url, headers: headers(), payload: { [field]: canary } });
  expect(checked(body, 400)).toEqual({ status: 'invalid_request' });
}
it.each(['actorId', 'memberId', 'silo', 'siloId'])(
  'refuses %s overrides in query and body', overrides);

async function replayAndReplacement() {
  const test = await fixture();
  const saved = await changeCompanyOptIn(nats.store, binding, 'admin', test.choice);
  const first = await app.inject({ url: test.url, headers: headers() });
  checked(first, 200);
  await app.close();
  app = server();
  const before = await nats.store.head();
  const append = vi.spyOn(nats.store, 'append');
  const read = vi.spyOn(nats.store, 'readStream');
  const replay = await app.inject({ url: test.url, headers: headers() });
  expect(checked(replay, 200)).toEqual(first.json());
  expect(append).not.toHaveBeenCalled();
  expect(await nats.store.head()).toBe(before);
  expect(read.mock.calls.map(readSubject)).toEqual([
    test.subject, `connection-company-${test.serverId}`, 'member-admin', 'ownership-test',
  ]);
  vi.restoreAllMocks();
  await nats.seed([{ ...test.registration, id: randomUUID() }]);
  const registrationRevision = await nats.store.head(test.subject);
  const undiscovered = await app.inject({ url: test.url, headers: headers() });
  expect(checked(undiscovered, 200)).toEqual({ enabled: false, sequence: saved.sequence,
    connectionId: null, registrationRevision });
  await nats.seed([{ ...test.discovery, id: randomUUID() }]);
  const replaced = await app.inject({ url: test.url, headers: headers() });
  expect(checked(replaced, 200)).toEqual({ enabled: false, sequence: saved.sequence,
    connectionId: 'installed', registrationRevision });
}
function readSubject(call: unknown[]) {
  return call[0];
}
it('replays without effects and invalidates old opt-in even with a reused connection id',
  replayAndReplacement);

async function failedHistory(target: string, removed: boolean) {
  const test = await fixture();
  const member = randomUUID();
  await join(member, 'admin');
  const originalRead = nats.store.readStream.bind(nats.store);
  let failedSubject = test.subject;
  if (target === 'control') {
    failedSubject = `connection-company-${test.serverId}`;
  }
  async function* fail(subject: string, from?: number, deadline?: number) {
    if (subject === failedSubject) {
      if (removed) {
        const event = envelope('test', `member-${member}`, 'member.removed', {
          memberId: member, removedBy: 'owner',
        });
        await nats.seed([event]);
      }
      throw new Error(canary);
    }
    yield* originalRead(subject, from, deadline);
  }
  const read = vi.spyOn(nats.store, 'readStream');
  read.mockImplementation(fail);
  const response = await app.inject({ url: test.url, headers: headers(member) });
  let expected = { status: 'unavailable' };
  let code = 503;
  if (removed) {
    expected = { status: 'refused' };
    code = 403;
  }
  expect(checked(response, code)).toEqual(expected);
  const subjects = read.mock.calls.map(readSubject);
  function membership(subject: unknown) {
    return subject === `member-${member}`;
  }
  expect(subjects.filter(membership)).toHaveLength(1);
  expect(subjects.indexOf(`member-${member}`)).toBeGreaterThan(subjects.indexOf(failedSubject));
}
it.each([['server', false], ['control', false], ['server', true], ['control', true]] as const)(
  'checks membership after failed %s history (removed: %s)', failedHistory);

async function slowHistory(removed: boolean) {
  const test = await fixture();
  const member = randomUUID();
  await join(member, 'admin');
  const originalRead = nats.store.readStream.bind(nats.store);
  async function* slow(subject: string, from?: number, deadline?: number) {
    if (subject === test.subject) {
      expect(deadline).toBeGreaterThan(performance.now() + 8000);
      await delay(2100);
      const chat = envelope('test', 'conversation-unrelated', 'conversation.created', {
        conversationId: 'unrelated', assistantId: 'assistant', createdBy: 'ordinary',
      });
      await nats.seed([chat]);
      if (removed) {
        const event = envelope('test', `member-${member}`, 'member.removed', {
          memberId: member, removedBy: 'owner',
        });
        await nats.seed([event]);
      }
    }
    yield* originalRead(subject, from, deadline);
  }
  const read = vi.spyOn(nats.store, 'readStream');
  read.mockImplementation(slow);
  const response = await app.inject({ url: test.url, headers: headers(member) });
  if (removed) {
    expect(checked(response, 403)).toEqual({ status: 'refused' });
  } else {
    expect(checked(response, 200)).toMatchObject({ enabled: false });
  }
  expect(read.mock.calls.map(readSubject)).toEqual([
    test.subject, `connection-company-${test.serverId}`, `member-${member}`, 'ownership-test',
  ]);
}
it.each([false, true])('loads slow history before checking access once (removed: %s)', slowHistory);

async function unavailableAndMissing() {
  const missing = '/api/org/integrations/missing/company-opt-in';
  const response = await app.inject({ url: missing, headers: headers() });
  expect(checked(response, 404)).toEqual({ status: 'not_found' });
  const anonymous = await app.inject({ url: missing });
  checked(anonymous, 401);
  const unavailable = buildServer(config);
  try {
    const response = await unavailable.inject({ url: missing, headers: headers() });
    expect(checked(response, 503)).toEqual({ status: 'unavailable' });
  } finally {
    await unavailable.close();
  }
  const read = vi.spyOn(nats.store, 'readStream');
  function failed(): never {
    throw new Error(canary);
  }
  read.mockImplementation(failed);
  const failedRead = await app.inject({ url: missing, headers: headers() });
  expect(checked(failedRead, 503)).toEqual({ status: 'unavailable' });
}
it('keeps missing, unauthenticated and unavailable replies private and uncached', unavailableAndMissing);

async function dependencyFailure(kind: string) {
  function failedLookup(): ReturnType<typeof memberId> {
    throw new Error(canary);
  }
  let currentBinding = binding;
  let lookup = memberId;
  if (kind === 'permissions') {
    currentBinding = { ...binding, apiUrl: 'http://127.0.0.1:1' };
  } else {
    lookup = failedLookup;
  }
  const unavailable = server(currentBinding, lookup);
  try {
    const response = await unavailable.inject({
      url: '/api/org/integrations/missing/company-opt-in', headers: headers(),
    });
    expect(checked(response, 503)).toEqual({ status: 'unavailable' });
  } finally {
    await unavailable.close();
  }
}
it.each(['permissions', 'member lookup'])('sanitises unavailable %s', dependencyFailure);

async function malformedBody() {
  const response = await app.inject({ url: '/api/org/integrations/missing/company-opt-in',
    headers: { ...headers(), 'content-type': 'application/json' }, payload: canary });
  expect(checked(response, 400)).toEqual({ status: 'invalid_request' });
}
it('keeps parser errors fixed and uncached without logging the body', malformedBody);
