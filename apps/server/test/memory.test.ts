import { mkdtemp, rm } from 'node:fs/promises';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { encodeSession } from '@opencrane/auth';
import { createStore, grantStream, memberAuthorisation } from '@opencrane/authz';
import { databases, openfga } from '@opencrane/authz/testing';
import { event, natsFixture } from '@opencrane/event-store/testing';
import { createLogger } from '@opencrane/observability';
import { computers, groups, memoryKeys, memoryProjection, memoryScopeId,
  pgDb, ProjectionRunner } from '@opencrane/projections';
import type { MemoryIdentity } from '@opencrane/events';
import { buildServer } from '../src/server.ts';
import { testAuthConfig } from './support/test-auth-config.ts';

const config = testAuthConfig({ expectedOrgId: 'org-acme' });
let nats: Awaited<ReturnType<typeof natsFixture>>;
let fga: Awaited<ReturnType<typeof openfga>>;
let storage: Awaited<ReturnType<typeof databases>>;
let auth: ReturnType<typeof memberAuthorisation>;
let app: ReturnType<typeof buildServer>;
let runner: ProjectionRunner;
let keys: ReturnType<typeof memoryKeys>;
let directory: string;
let count = 0;
const projection = memoryProjection({ decrypt });
function decrypt(identity: MemoryIdentity, encrypted: { ciphertext: string; keyId: string }) {
  return keys.decrypt(identity, encrypted);
}
async function append(subject: string, type: string, data: unknown, apply = true,
  silo = 'acme', principal = 'bob') {
  const id = `memory-test-${++count}`;
  const principalValue = { kind: 'human' as const, id: principal };
  const record = { ...event(id, subject, type), silo, data, commandId: id,
    principal: principalValue };
  const command = { event: record, expectedSequence: await nats.store.head(subject),
    historyChecked: true as const };
  expect((await nats.store.append(command)).status).toBe('appended');
  if (apply && auth.handler.eventTypes.includes(type)) {
    await auth.handler.handle(record, pgDb(storage.queue));
  }
  return record;
}
async function write(ownerId: string, scopeKind: MemoryIdentity['scopeKind'],
  memoryId: string, text = 'Deliveries café 東京', pinned = false, silo = 'acme') {
  const scopeId = memoryScopeId(silo, scopeKind, ownerId);
  const identity = { silo, scopeId, scopeKind, ownerId, memoryId, revision: 1 };
  keys.provision(identity);
  const encrypted = keys.encrypt(identity, text);
  const data = { schemaVersion: 1, scopeId, scopeKind, ownerId, memoryId, revision: 1,
    kind: 'fact', pinned, expiresAt: null, sources: [], dependsOn: [], ...encrypted };
  return append(`scope-${scopeId}`, 'memory.written', data, true, silo);
}
function resolveMember(_silo: string, _issuer: string, subject: string) {
  return Promise.resolve(subject.replace('idp-', ''));
}
function get(url: string, memberId = 'bob', orgId = 'org-acme') {
  const session = { sub: `idp-${memberId}`, orgId, roles: ['owner'],
    authTime: 1790856000, exp: 2000000000 };
  const headers = { cookie: `${config.cookieName}=${encodeSession(config, session)}` };
  return app.inject({ method: 'GET', url, headers });
}
function path(ownerId: string, kind: MemoryIdentity['scopeKind'] = 'person') {
  return `/api/memory/${memoryScopeId('acme', kind, ownerId)}`;
}
async function setup() {
  nats = await natsFixture();
  fga = await openfga();
  storage = await databases();
  directory = await mkdtemp('/tmp/memory-http-');
  keys = memoryKeys(directory);
  const binding = await createStore(fga.apiUrl, 'acme');
  auth = memberAuthorisation(binding);
  const db = pgDb(storage.queue);
  runner = new ProjectionRunner(db, nats.reader, createLogger('memory-http'));
  for (const target of [projection, groups, computers]) await runner.initialise(target);
  for (const [memberId, role] of [['owner', 'owner'], ['admin', 'admin'], ['bob', 'member']]) {
    await append(`member-${memberId}`, 'member.joined', {
      memberId, role, email: `${memberId}@example.test`, displayName: memberId,
    });
  }
  await append('team-sales', 'team.created',
    { teamId: 'sales', name: 'Sales', createdBy: 'owner' });
  await append('team-sales', 'team.member_added',
    { teamId: 'sales', memberId: 'bob', addedBy: 'owner' });
  for (const [assistantId, kind, ownerId] of [
    ['personal', 'personal', 'bob'], ['shared', 'team', 'sales'],
  ]) {
    await append(`assistant-${assistantId}`, 'assistant.created', { assistantId, kind, ownerId });
    const scopeId = memoryScopeId('acme', 'assistant_notes', assistantId!);
    await append(grantStream('memory_read', scopeId), 'grant.given', {
      resourceType: 'memory_read', resourceId: scopeId,
      granteeKind: 'member', granteeId: 'bob', grantedBy: 'owner',
    });
    await write(assistantId!, 'assistant_notes', 'note');
  }
  await write('bob', 'person', 'own');
  await write('owner', 'person', 'private');
  await write('sales', 'group', 'shared');
  await write('bob', 'person', 'foreign', 'Foreign secret', false, 'foreign');
  for (const target of [projection, groups, computers]) await runner.run(target);
  const memory = { silo: 'acme', store: nats.store, db, binding,
    feed: { memberId: resolveMember } };
  app = buildServer(config, { memory });
}
async function cleanup() {
  await app?.close();
  await storage?.close();
  await fga?.close();
  await nats?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
}
beforeAll(setup, 120_000);
afterAll(cleanup);

it('offers own, group and assistant scopes with separate read and write rights', async function scopes() {
  const response = await get('/api/memory/scopes?groupId=sales&assistantId=shared');
  expect(response.statusCode).toBe(200);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.json()).toMatchObject({ scopes: [
    { scopeKind: 'person', ownerId: 'bob', canRead: true, canWrite: true },
    { scopeKind: 'group', ownerId: 'sales', canRead: true, canWrite: true },
    { scopeKind: 'assistant_notes', ownerId: 'shared', canRead: true, canWrite: false },
  ], limits: { textBytes: 4096, pageFacts: 20, pageBytes: 16384 } });
});
it.each([
  ['bob', 'bob', 'person', 'own', 200],
  ['owner', 'bob', 'person', 'own', 404],
  ['admin', 'bob', 'person', 'own', 404],
  ['bob', 'sales', 'group', 'shared', 200],
  ['owner', 'sales', 'group', 'shared', 404],
  ['bob', 'personal', 'assistant_notes', 'note', 200],
  ['bob', 'shared', 'assistant_notes', 'note', 200],
  ['admin', 'shared', 'assistant_notes', 'note', 404],
] as const)('checks %s reading %s %s', async function matrix(member, owner, kind, id, status) {
  const response = await get(`${path(owner, kind)}/facts`, member);
  expect(response.statusCode).toBe(status);
  expect(response.headers['cache-control']).toBe('no-store');
  if (status === 404) expect(response.json()).toEqual({ status: 'refused' });
  else expect(response.json()).toMatchObject({ facts: [{ memoryId: id }] });
});
it('uses one refusal for unknown, foreign and forbidden ids', async function refusedIds() {
  const urls = [`${path('owner')}/facts`,
    `/api/memory/${memoryScopeId('foreign', 'person', 'bob')}/facts`,
    `/api/memory/${'a'.repeat(64)}/facts`];
  for (const url of urls) {
    const response = await get(url);
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ status: 'refused' });
  }
  expect((await get(`${path('bob')}/facts`, 'bob', 'foreign')).statusCode).toBe(404);
});
it('ranks pins, exact terms and prefixes, with bounded Unicode search', async function search() {
  await write('bob', 'person', 'prefix', 'Deliveries');
  await write('bob', 'person', 'exact', 'Deliver');
  await write('bob', 'person', 'pin', 'Deliveries', true);
  await runner.run(projection);
  const response = await get(`${path('bob')}/facts?q=deliver`);
  expect(response.statusCode).toBe(200);
  const results = response.json<{ facts: { memoryId: string }[] }>();
  function factId(fact: { memoryId: string }) {
    return fact.memoryId;
  }
  expect(results.facts.map(factId))
    .toEqual(['pin', 'exact', 'own', 'prefix']);
  expect((await get(`${path('bob')}/facts?q=${encodeURIComponent('café 東京')}`))
    .json()).toMatchObject({ returnedCount: 1 });
  for (const query of ['x'.repeat(257), 'a b c d e f g h i', '!!!']) {
    expect((await get(`${path('bob')}/facts?q=${encodeURIComponent(query)}`)).statusCode).toBe(422);
  }
});
it.each([
  ['hindi', 'मेरी पसंदीदा भाषा हिन्दी', 'मेरी पसंदीदा भाषा हिन्दी'],
  ['accent_saved', 'Cafe\u0301 maison', 'Café maison'],
  ['accent_query', 'Café jardin', 'Cafe\u0301 jardin'],
  ['japanese', '東京 配送', '東京 配送'],
  ['latin', 'Morning delivery instructions', 'Morning delivery instructions'],
])('finds whole Unicode words for %s', async function unicodeWords(id, text, query) {
  await write('bob', 'person', id, text);
  await runner.run(projection);
  const response = await get(`${path('bob')}/facts?q=${encodeURIComponent(query)}`);
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ facts: [{ memoryId: id }], returnedCount: 1 });
  const saved = await storage.queue.query<{ search_text: string }>(
    'SELECT search_text FROM memory_facts WHERE memory_id=$1', [id]);
  expect(saved.rows[0]?.search_text).toBe(text.normalize('NFC'));
});
it('caps whole pages and binds cursors to identity, query, scope and rebuilt content',
  async function paging() {
    for (let index = 0; index < 22; index++) {
      await write('bob', 'person', `large_${index}`, 'é'.repeat(1800));
      await write('sales', 'group', `small_${index}`, 'Small statement');
    }
    await runner.run(projection);
    const first = await get(`${path('bob')}/facts`);
    expect(first.statusCode).toBe(200);
    expect(Buffer.byteLength(first.body)).toBeLessThanOrEqual(16384);
    const page = first.json<{ facts: { text: string }[]; nextCursor: string }>();
    expect(page.facts.length).toBeLessThanOrEqual(20);
    expect(page.nextCursor).toBeTruthy();
    const cursor = encodeURIComponent(page.nextCursor);
    expect((await get(`${path('bob')}/facts?cursor=${cursor}`)).statusCode).toBe(200);
    expect((await get(`${path('bob')}/facts?cursor=${cursor}&q=café`)).statusCode).toBe(409);
    expect((await get(`${path('sales', 'group')}/facts?cursor=${cursor}`)).statusCode).toBe(409);
    expect((await get(`${path('bob')}/facts?cursor=${cursor}`, 'admin')).statusCode).toBe(404);
    expect((await get(`${path('bob')}/facts?cursor=${cursor}x`)).statusCode).toBe(409);
    await append('team-sales', 'team.member_added',
      { teamId: 'sales', memberId: 'owner', addedBy: 'owner' });
    const groupPage = (await get(`${path('sales', 'group')}/facts`)).json<{
      returnedCount: number; nextCursor: string }>();
    expect(groupPage.returnedCount).toBe(20);
    const groupCursor = encodeURIComponent(groupPage.nextCursor);
    expect((await get(`${path('sales', 'group')}/facts?cursor=${groupCursor}`, 'owner'))
      .statusCode).toBe(409);
    await write('bob', 'person', 'new');
    await runner.run(projection);
    expect((await get(`${path('bob')}/facts?cursor=${cursor}`)).statusCode).toBe(409);
    const beforeRebuild = (await get(`${path('bob')}/facts`)).json<{ nextCursor: string }>();
    await runner.rebuild(projection);
    const oldCursor = encodeURIComponent(beforeRebuild.nextCursor);
    expect((await get(`${path('bob')}/facts?cursor=${oldCursor}`)).statusCode).toBe(409);
  });
it('returns unavailable until the projection has caught up', async function lag() {
  await write('bob', 'person', 'lag');
  expect((await get(`${path('bob')}/facts`)).statusCode).toBe(503);
  expect((await get('/api/memory/scopes')).statusCode).toBe(503);
  await runner.run(projection);
  expect((await get(`${path('bob')}/facts`)).statusCode).toBe(200);
});
it('lists an empty group and refuses notes without a recorded read grant', async function empty() {
  await append('team-empty', 'team.created',
    { teamId: 'empty', name: 'Empty', createdBy: 'owner' });
  await append('team-empty', 'team.member_added',
    { teamId: 'empty', memberId: 'bob', addedBy: 'owner' });
  await append('assistant-ungranted', 'assistant.created',
    { assistantId: 'ungranted', kind: 'personal', ownerId: 'bob' });
  await runner.run(groups);
  await runner.run(computers);
  expect((await get(`${path('empty', 'group')}/facts`)).json())
    .toMatchObject({ facts: [], returnedCount: 0, nextCursor: null });
  expect((await get(`${path('ungranted', 'assistant_notes')}/facts`)).statusCode).toBe(404);
});
it('keeps reads open during long-chat and memory activity without a write fence', async function activity() {
  const message = { conversationId: 'busy', authorId: 'bob', authorKind: 'human',
    ciphertext: 'AAAAAAAAAAAAAAAAAAAA', keyId: 'key:chat', contentType: 'text' };
  for (let index = 0; index < 100; index++) {
    await append('conversation-busy', 'message.posted', message);
  }
  const original = nats.store.head.bind(nats.store);
  const originalRead = nats.store.readStream.bind(nats.store);
  let readStarted: () => void;
  const started = new Promise<void>(function ready(resolve) {
    readStarted = resolve;
  });
  let delayed = false;
  async function head(subject?: string, deadline?: number) {
    const position = await original(subject, deadline);
    if (subject?.startsWith('scope-') && !delayed) {
      delayed = true;
      readStarted();
      await new Promise(function wait(resolve) {
        setTimeout(resolve, 2100);
      });
    }
    return position;
  }
  function read(subject: string, from?: number, deadline?: number) {
    expect(subject).not.toMatch(/^conversation-/u);
    return originalRead(subject, from, deadline);
  }
  const headSpy = vi.spyOn(nats.store, 'head').mockImplementation(head);
  const readSpy = vi.spyOn(nats.store, 'readStream').mockImplementation(read);
  try {
    const response = get(`${path('bob')}/facts`);
    await started;
    await append('conversation-busy', 'message.posted', message);
    await write('bob', 'person', 'during-read');
    await runner.run(projection);
    expect((await response).statusCode).toBe(200);
  } finally {
    headSpy.mockRestore();
    readSpy.mockRestore();
  }
});
it('refuses grants for outsiders, inactive assistants and unapplied revocations', async function revoke() {
  const scopeId = memoryScopeId('acme', 'assistant_notes', 'shared');
  await append(grantStream('memory_read', scopeId), 'grant.given', {
    resourceType: 'memory_read', resourceId: scopeId, granteeKind: 'member',
    granteeId: 'admin', grantedBy: 'owner',
  });
  expect((await get(`${path('shared', 'assistant_notes')}/facts`, 'admin')).statusCode).toBe(404);
  await append('assistant-personal', 'assistant.settings_changed', {
    assistantId: 'personal', changedBy: 'owner', active: false, changedFields: ['active'],
  }, false);
  expect((await get(`${path('personal', 'assistant_notes')}/facts`)).statusCode).toBe(404);
  await append(grantStream('memory_read', scopeId), 'grant.revoked', {
    resourceType: 'memory_read', resourceId: scopeId, granteeId: 'bob', revokedBy: 'owner',
  }, false);
  expect((await get(`${path('shared', 'assistant_notes')}/facts`)).statusCode).toBe(503);
  await append('team-sales', 'team.member_removed',
    { teamId: 'sales', memberId: 'bob', removedBy: 'owner' }, false);
  expect((await get(`${path('sales', 'group')}/facts`)).statusCode).toBe(404);
});
