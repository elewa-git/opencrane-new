import { mkdtemp, rm, readFile, writeFile, copyFile, access } from 'node:fs/promises';
import { z } from 'zod';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { encodeSession } from '@opencrane/auth';
import { createStore, grantStream, memberAuthorisation } from '@opencrane/authz';
import { databases, openfga } from '@opencrane/authz/testing';
import { event, natsFixture } from '@opencrane/event-store/testing';
import { createLogger } from '@opencrane/observability';
import { computers, groups, memoryKeys, conversationKeys, memoryProjection, memoryScopeId,
  pgDb, ProjectionRunner, conversations } from '@opencrane/projections';
import { memoryWrittenEventSchema, type MemoryIdentity,
  type memoryWrittenDataSchema } from '@opencrane/events';
import type { MemoryOptions } from '../src/memory/access.ts';
import { reconcileCommands } from '../src/memory/commands.ts';
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
let memory: import('../src/memory/access.ts').MemoryOptions;
import type { MemoryOptions } from '../src/memory/access.ts';
import { reconcileCommands } from '../src/memory/commands.ts';
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
  memoryId: string, text = 'Deliveries café 東京', pinned = false, silo = 'acme',
  sources: z.infer<typeof memoryWrittenDataSchema>['sources'] = []) {
  const scopeId = memoryScopeId(silo, scopeKind, ownerId);
  const identity = { silo, scopeId, scopeKind, ownerId, memoryId, revision: 1 };
  keys.provision(identity);
  const encrypted = keys.encrypt(identity, text);
  const data = { schemaVersion: 1, scopeId, scopeKind, ownerId, memoryId, revision: 1,
    kind: 'fact', pinned, expiresAt: null, sources, dependsOn: [], ...encrypted };
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
  for (const target of [projection, groups, computers, conversations]) await runner.initialise(target);
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
  memory = { silo: 'acme', store: nats.store, db, binding,
    feed: { memberId: resolveMember }, keyDirectory: directory };
  memory.chat = { ...memory, keys: conversationKeys(directory) };
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
  else expect(response.json()).toMatchObject({ facts: [
    { memoryId: id, text: 'Deliveries café 東京', kind: 'fact', revision: 1 },
  ] });
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
it('returns an unavailable placeholder for one fact that exceeds a page', async function oversize() {
  await write('bob', 'person', 'oversize', 'Oversize marker');
  await write('bob', 'person', 'oversize_after', 'Oversize marker after');
  await runner.run(projection);
  await storage.queue.query('UPDATE memory_facts SET search_text=$1 WHERE memory_id=$2',
    ['\u0001'.repeat(4096), 'oversize']);
  const response = await get(`${path('bob')}/facts?q=oversize`);
  expect(response.statusCode).toBe(200);
  expect(Buffer.byteLength(response.body)).toBeLessThanOrEqual(16384);
  expect(response.json()).toMatchObject({ facts: [
    { memoryId: 'oversize', revision: 1, reason: 'page_limit' },
    { memoryId: 'oversize_after', text: 'Oversize marker after' },
  ], returnedCount: 2, nextCursor: null });
  expect(response.json<{ facts: object[] }>().facts[0]).not.toHaveProperty('text');
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
  const scopes = await get('/api/memory/scopes');
  expect(scopes.statusCode).toBe(503);
  expect(scopes.json()).toEqual({ status: 'unavailable', reason: 'memory_unavailable' });
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
it('binds a cursor to its requester when both people can read the group',
  async function cursorRequester() {
    await append('team-sales', 'team.member_added',
      { teamId: 'sales', memberId: 'owner', addedBy: 'owner' });
    for (let index = 0; index < 21; index++) {
      await write('sales', 'group', `requester_${index}`, 'Requester marker');
    }
    for (const target of [projection, groups, computers]) await runner.run(target);
    const first = await get(`${path('sales', 'group')}/facts?q=requester`);
    const cursor = first.json<{ nextCursor: string }>().nextCursor;
    expect(cursor).toBeTruthy();
    const url = `${path('sales', 'group')}/facts?q=requester&cursor=${encodeURIComponent(cursor)}`;
    expect((await get(url, 'owner')).statusCode).toBe(409);
  });

async function notes(assistantId: string, granteeKind = 'member', granteeId = 'bob') {
  const created = await append(`assistant-${assistantId}`, 'assistant.created',
    { assistantId, kind: 'team', ownerId: 'sales' });
  const scopeId = memoryScopeId('acme', 'assistant_notes', assistantId);
  const granted = await append(grantStream('memory_read', scopeId), 'grant.given', {
    resourceType: 'memory_read', resourceId: scopeId, granteeKind, granteeId,
    grantedBy: 'owner',
  });
  await write(assistantId, 'assistant_notes', 'note');
  for (const target of [projection, groups, computers]) await runner.run(target);
  return { created, granted, scopeId };
}

it('reads team-kind memory grants and refuses an applied revoke', async function teamGrant() {
  const current = await notes('team-grant', 'team', 'sales');
  const url = `${path('team-grant', 'assistant_notes')}/facts`;
  expect((await get(url)).json()).toMatchObject({ facts: [{ memoryId: 'note' }] });
  await append(grantStream('memory_read', current.scopeId), 'grant.revoked', {
    resourceType: 'memory_read', resourceId: current.scopeId,
    granteeKind: 'team', granteeId: 'sales', revokedBy: 'owner',
  });
  const stalePermission = { allowed: true, status: 'ok' as const };
  const spy = vi.spyOn(auth, 'use').mockResolvedValue(stalePermission);
  try {
    expect((await get(url)).statusCode).toBe(404);
  } finally {
    spy.mockRestore();
  }
});

it.each(['refused', 'unavailable'] as const)('handles actsFor %s',
  async function acting(status) {
    await notes(`acting-${status}`);
    const result = { allowed: false, status: 'ok' as const };
    const unavailable = { allowed: false as const, status: 'unavailable' as const,
      error: new Error('Permissions unavailable') };
    const response = status === 'refused' ? result : unavailable;
    const spy = vi.spyOn(auth, 'actsFor').mockResolvedValue(response);
    try {
      const expected = status === 'refused' ? 404 : 503;
      expect((await get(`${path(`acting-${status}`, 'assistant_notes')}/facts`))
        .statusCode).toBe(expected);
    } finally {
      spy.mockRestore();
    }
  });

it('waits for an unapplied assistant creation', async function assistantApplying() {
  const current = await notes('assistant-applying');
  const original = auth.applied.bind(auth);
  function applied(eventId: string) {
    if (eventId === current.created.id) return Promise.resolve(false);
    return original(eventId);
  }
  const spy = vi.spyOn(auth, 'applied').mockImplementation(applied);
  try {
    expect((await get(`${path('assistant-applying', 'assistant_notes')}/facts`))
      .statusCode).toBe(503);
  } finally {
    spy.mockRestore();
  }
});

it('excludes expired, destroyed and quarantined content', async function excluded() {
  for (const id of ['filter_live', 'filter_expired', 'filter_destroyed', 'filter_quarantined']) {
    await write('bob', 'person', id, 'Filtering marker');
  }
  await runner.run(projection);
  await storage.queue.query("UPDATE memory_facts SET expires_at=$1 WHERE memory_id=$2",
    ['2020-01-01T00:00:00Z', 'filter_expired']);
  await storage.queue.query("UPDATE memory_facts SET content_status='unavailable' WHERE memory_id=$1",
    ['filter_destroyed']);
  await storage.queue.query("UPDATE memory_facts SET content_status='quarantined' WHERE memory_id=$1",
    ['filter_quarantined']);
  const response = await get(`${path('bob')}/facts?q=filtering`);
  expect(response.json()).toMatchObject({ facts: [{ memoryId: 'filter_live' }], returnedCount: 1 });
});

it('refuses a rebuild that starts during the content query', async function rebuilding() {
  const original = memory.db.query.bind(memory.db);
  async function query<Row extends Record<string, unknown>>(sql: string, values?: unknown[]) {
    if (sql.includes('FROM memory_facts') && sql.includes('ORDER BY pinned')) {
      await runner.rebuild(projection);
    }
    return original<Row>(sql, values);
  }
  const spy = vi.spyOn(memory.db, 'query').mockImplementation(query);
  try {
    expect((await get(`${path('bob')}/facts`)).statusCode).toBe(503);
  } finally {
    spy.mockRestore();
  }
});

it('refuses a rebuild after the content query', async function rebuiltAfterQuery() {
  const original = memory.db.query.bind(memory.db);
  async function query<Row extends Record<string, unknown>>(sql: string, values?: unknown[]) {
    const result = await original<Row>(sql, values);
    if (sql.includes('FROM memory_facts') && sql.includes('ORDER BY pinned')) await runner.rebuild(projection);
    return result;
  }
  const spy = vi.spyOn(memory.db, 'query').mockImplementation(query);
  try {
    expect((await get(`${path('bob')}/facts`)).statusCode).toBe(503);
  } finally {
    spy.mockRestore();
  }
});

it('refuses mismatched silo bindings and missing member bindings', async function bindings() {
  const silo = memory.silo;
  const memberId = memory.feed.memberId;
  try {
    memory.silo = 'other';
    expect((await get('/api/memory/scopes')).statusCode).toBe(404);
    memory.silo = silo;
    function absentMember() {
      return Promise.resolve(undefined);
    }
    memory.feed.memberId = absentMember;
    expect((await get('/api/memory/scopes')).statusCode).toBe(404);
  } finally {
    memory.silo = silo;
    memory.feed.memberId = memberId;
  }
});

it('refuses notes without saved grants even when OpenFGA allows use', async function absentGrant() {
  await append('assistant-without-grant', 'assistant.created',
    { assistantId: 'without-grant', kind: 'personal', ownerId: 'bob' });
  await runner.run(computers);
  const stalePermission = { allowed: true, status: 'ok' as const };
  const spy = vi.spyOn(auth, 'use').mockResolvedValue(stalePermission);
  try {
    const response = await get(`${path('without-grant', 'assistant_notes')}/facts`);
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ status: 'refused' });
  } finally {
    spy.mockRestore();
  }
});

it('skips stored ids outside the memory format with uniform refusals', async function storedIds() {
  await storage.queue.query("UPDATE groups SET group_id='bad.id' WHERE group_id='sales'");
  await storage.queue.query("UPDATE computers SET assistant_id='bad.id' WHERE assistant_id='shared'");
  try {
    const scopes = ['owner', 'nobody'];
    for (const owner of scopes) {
      const response = await get(`${path(owner)}/facts`);
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ status: 'refused' });
    }
    const unknown = await get(`/api/memory/${'a'.repeat(64)}/facts`);
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toEqual({ status: 'refused' });
  } finally {
    await storage.queue.query("UPDATE groups SET group_id='sales' WHERE group_id='bad.id'");
    await storage.queue.query("UPDATE computers SET assistant_id='shared' WHERE assistant_id='bad.id'");
  }
});

it('reports setup read-table lag for a new empty group or assistant', async function setupLag() {
  await append('team-late', 'team.created',
    { teamId: 'late', name: 'Late group', createdBy: 'owner' });
  await append('team-late', 'team.member_added',
    { teamId: 'late', memberId: 'bob', addedBy: 'owner' });
  await append('assistant-late', 'assistant.created',
    { assistantId: 'late', kind: 'personal', ownerId: 'bob' });
  const scopeId = memoryScopeId('acme', 'assistant_notes', 'late');
  await append(grantStream('memory_read', scopeId), 'grant.given', {
    resourceType: 'memory_read', resourceId: scopeId,
    granteeKind: 'member', granteeId: 'bob', grantedBy: 'owner',
  });
  for (const kind of ['group', 'assistant_notes'] as const) {
    expect((await get(`${path('late', kind)}/facts`)).statusCode).toBe(503);
  }
  for (const target of [groups, computers]) await runner.run(target);
  for (const kind of ['group', 'assistant_notes'] as const) {
    const response = await get(`${path('late', kind)}/facts`);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ facts: [], returnedCount: 0 });
  }
});

it('ignores unapplied grants and revokes for unrelated people and groups', async function unrelated() {
  const current = await notes('unrelated');
  await append('team-other', 'team.created',
    { teamId: 'other', name: 'Other group', createdBy: 'owner' });
  await runner.run(groups);
  for (const [granteeKind, granteeId] of [['member', 'admin'], ['team', 'other'],
    ['assistant', 'another-assistant']]) {
    const grant = { resourceType: 'memory_read', resourceId: current.scopeId,
      granteeKind, granteeId, grantedBy: 'owner' };
    await append(grantStream('memory_read', current.scopeId), 'grant.given', grant, false);
    expect((await get(`${path('unrelated', 'assistant_notes')}/facts`)).statusCode).toBe(200);
    const revoke = { resourceType: 'memory_read', resourceId: current.scopeId,
      granteeKind, granteeId, revokedBy: 'owner' };
    await append(grantStream('memory_read', current.scopeId), 'grant.revoked', revoke, false);
    expect((await get(`${path('unrelated', 'assistant_notes')}/facts`)).statusCode).toBe(200);
  }
});

it.each(['member', 'team', 'assistant'] as const)('waits for a relevant %s grant',
  async function relevant(kind) {
    const current = await notes(`relevant-${kind}`);
    const granteeIds = { member: 'bob', team: 'sales', assistant: `relevant-${kind}` };
    await append(grantStream('memory_read', current.scopeId), 'grant.given', {
      resourceType: 'memory_read', resourceId: current.scopeId,
      granteeKind: kind, granteeId: granteeIds[kind], grantedBy: 'owner',
    }, false);
    expect((await get(`${path(`relevant-${kind}`, 'assistant_notes')}/facts`)).statusCode).toBe(503);
  });

it('keeps grant kinds separate when their ids match', async function sameIds() {
  const current = await notes('same-ids', 'team', 'sales');
  await append(grantStream('memory_read', current.scopeId), 'grant.given', {
    resourceType: 'memory_read', resourceId: current.scopeId,
    granteeKind: 'assistant', granteeId: 'sales', grantedBy: 'owner',
  });
  await append(grantStream('memory_read', current.scopeId), 'grant.revoked', {
    resourceType: 'memory_read', resourceId: current.scopeId,
    granteeKind: 'assistant', granteeId: 'sales', revokedBy: 'owner',
  });
  expect((await get(`${path('same-ids', 'assistant_notes')}/facts`)).statusCode).toBe(200);
});

it('checks each saved grant once per request and checks again on the next request',
  async function receiptCache() {
    const current = await notes('receipt-cache');
    const original = nats.store.readStream.bind(nats.store);
    async function* read(subject: string, from?: number, deadline?: number) {
      for await (const row of original(subject, from, deadline)) {
        yield row;
        if (row.event.id === current.granted.id) yield row;
      }
    }
    const readSpy = vi.spyOn(nats.store, 'readStream').mockImplementation(read);
    const appliedSpy = vi.spyOn(auth, 'applied');
    function isGrantCheck(call: [string]) {
      return call[0] === current.granted.id;
    }
    try {
      const url = `${path('receipt-cache', 'assistant_notes')}/facts`;
      expect((await get(url)).statusCode).toBe(200);
      expect(appliedSpy.mock.calls.filter(isGrantCheck)).toHaveLength(1);
      expect((await get(url)).statusCode).toBe(200);
      expect(appliedSpy.mock.calls.filter(isGrantCheck)).toHaveLength(2);
    } finally {
      readSpy.mockRestore();
      appliedSpy.mockRestore();
    }
  });

it('reuses applied membership checks across scopes only within one request',
  async function membershipCache() {
    await notes('membership-cache', 'team', 'sales');
    const appliedSpy = vi.spyOn(auth, 'applied');
    try {
      const url = '/api/memory/scopes?groupId=sales&assistantId=membership-cache';
      const response = await get(url);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ scopes: [
        { scopeKind: 'person' }, { scopeKind: 'group' },
        { scopeKind: 'assistant_notes', canRead: true },
      ] });
      const seen = new Set<string>();
      for (const [eventId] of appliedSpy.mock.calls) {
        expect(seen.has(eventId), eventId).toBe(false);
        seen.add(eventId);
      }
      appliedSpy.mockResolvedValue(false);
      expect((await get(url)).statusCode).toBe(503);
    } finally {
      appliedSpy.mockRestore();
    }
  });

it('treats equal expiry instants with different timestamp text as expired',
  async function equalExpiry() {
    await write('bob', 'person', 'equal_expiry', 'Equal expiry marker');
    await runner.run(projection);
    await storage.queue.query('UPDATE memory_facts SET expires_at=$1 WHERE memory_id=$2',
      ['2026-10-09T11:00:00Z', 'equal_expiry']);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-10-09T11:00:00.000Z'));
      const response = await get(`${path('bob')}/facts?q=equal`);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ facts: [], returnedCount: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

it('compares expiry as an instant and keeps the first page time', async function expiryPages() {
  for (let index = 0; index < 23; index++) {
    await write('bob', 'person', `expiry_${String(index).padStart(2, '0')}`, 'Expiry marker');
  }
  await runner.run(projection);
  await storage.queue.query('UPDATE memory_facts SET expires_at=$1 WHERE memory_id=$2',
    ['2026-10-09T12:00:00Z', 'expiry_00']);
  await storage.queue.query('UPDATE memory_facts SET expires_at=$1 WHERE memory_id=$2',
    ['2026-10-09T12:00:00Z', 'expiry_21']);
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    vi.setSystemTime(new Date('2026-10-09T11:59:59Z'));
    const first = await get(`${path('bob')}/facts?q=expiry`);
    expect(first.statusCode).toBe(200);
    const cursor = first.json<{ nextCursor: string }>().nextCursor;
    expect(first.json()).toMatchObject({ returnedCount: 20 });
    vi.setSystemTime(new Date('2026-10-09T12:00:01Z'));
    const second = await get(`${path('bob')}/facts?q=expiry&cursor=${encodeURIComponent(cursor)}`);
    expect(second.json()).toMatchObject({ facts: [
      { memoryId: 'expiry_20' }, { memoryId: 'expiry_21' }, { memoryId: 'expiry_22' },
    ], returnedCount: 3, nextCursor: null });
    const latest = await get(`${path('bob')}/facts?q=expiry`);
    expect(latest.json<{ facts: { memoryId: string }[] }>().facts[0]?.memoryId).toBe('expiry_01');
    await storage.queue.query('UPDATE memory_facts SET expires_at=$1 WHERE memory_id=$2',
      ['2026-10-09T12:00:01.000Z', 'expiry_01']);
    const atExpiry = await get(`${path('bob')}/facts?q=expiry`);
    expect(atExpiry.json<{ facts: { memoryId: string }[] }>().facts[0]?.memoryId)
      .toBe('expiry_02');
  } finally {
    vi.useRealTimers();
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

it('returns authorised fact detail within 16 KiB and uses uniform refusals', async function detail() {
  const response = await get(`${path('bob')}/facts/own`);
  expect(response.statusCode).toBe(200);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.json()).toMatchObject({ fact: { memoryId: 'own', revision: 1,
    text: 'Deliveries café 東京' }, sources: [] });
  expect(Buffer.byteLength(response.body)).toBeLessThanOrEqual(16384);
  for (const url of [`${path('bob')}/facts/unseen`, `${path('owner')}/facts/private`,
    `/api/memory/${memoryScopeId('foreign', 'person', 'bob')}/facts/foreign`]) {
    expect((await get(url)).json()).toEqual({ status: 'refused' });
  }
  await storage.queue.query('UPDATE memory_facts SET search_text=$1 WHERE memory_id=$2',
    ['\u0001'.repeat(4096), 'own']);
  expect((await get(`${path('bob')}/facts/own`)).statusCode).toBe(503);
});
it('resolves source status separately and hides denied source references', async function sources() {
  await append('conversation-detail_chat', 'conversation.created', {
    conversationId: 'detail_chat', createdBy: 'bob', mode: 'direct', participantIds: ['bob', 'owner'],
  });
  const message = await append('conversation-detail_chat', 'message.posted', {
    conversationId: 'detail_chat', authorId: 'bob', authorKind: 'human',
    ciphertext: 'AAAAAAAAAAAAAAAAAAAA', keyId: 'key:chat', contentType: 'text',
  });
  const references = [{ conversationId: 'detail_chat', messageId: message.id }];
  await write('bob', 'person', 'with_source', 'A sourced fact', false, 'acme', references);
  await runner.run(projection);
  await runner.run(conversations);
  const url = `${path('bob')}/facts/with_source`;
  expect((await get(url)).json()).toMatchObject({ sources: [{ status: 'available',
    reference: references[0] }] });
  const denied = { allowed: false, status: 'ok' as const };
  const permission = vi.spyOn(auth, 'conversation').mockResolvedValue(denied);
  let refused;
  try { refused = await get(url); }
  finally { permission.mockRestore(); }
  expect(refused.statusCode).toBe(200);
  expect(refused.json()).toMatchObject({ fact: { text: 'A sourced fact' },
    sources: [{ status: 'refused' }] });
  expect(refused.body).not.toContain('detail_chat');
});


it('returns a typed unavailable result after a fact key is destroyed', async function destroyedDetail() {
  await write('bob', 'person', 'detail-destroyed', 'Destroyed private text');
  const identity = { silo: 'acme', scopeId: memoryScopeId('acme', 'person', 'bob'),
    scopeKind: 'person' as const, ownerId: 'bob', memoryId: 'detail-destroyed', revision: 1 };
  keys.delete(identity);
  await runner.rebuild(projection);
  const response = await get(`${path('bob')}/facts/detail-destroyed`);
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ status: 'unavailable', memoryId: 'detail-destroyed',
    revision: 1, reason: 'destroyed' });
  expect(response.body).not.toContain('Destroyed private text');
  expect(response.json()).not.toHaveProperty('fact');
});

it('returns quarantined fact detail without any text', async function quarantinedDetail() {
  await write('bob', 'person', 'detail-quarantined', 'Quarantined private text');
  await runner.run(projection);
  await storage.queue.query("UPDATE memory_facts SET content_status='quarantined' WHERE memory_id=$1",
    ['detail-quarantined']);
  const response = await get(`${path('bob')}/facts/detail-quarantined`);
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ status: 'unavailable', memoryId: 'detail-quarantined',
    revision: 1, reason: 'quarantined' });
  expect(response.body).not.toContain('Quarantined private text');
  expect(response.json()).not.toHaveProperty('fact');
});

it('refuses expired detail and waits for projection catch-up', async function detailExpiryAndLag() {
  await write('bob', 'person', 'detail-lag');
  const url = `${path('bob')}/facts/detail-lag`;
  expect((await get(url)).statusCode).toBe(503);
  await runner.run(projection);
  expect((await get(url)).statusCode).toBe(200);
  await storage.queue.query('UPDATE memory_facts SET expires_at=$1 WHERE memory_id=$2',
    ['2020-01-01T00:00:00Z', 'detail-lag']);
  expect((await get(url)).statusCode).toBe(404);
});

it('checks read grants for notes detail separately from write grants', async function notesDetail() {
  for (const operation of ['memory_read', 'memory_write']) {
    const assistantId = `detail-${operation}`;
    await append(`assistant-${assistantId}`, 'assistant.created',
      { assistantId, kind: 'personal', ownerId: 'bob' });
    const scopeId = memoryScopeId('acme', 'assistant_notes', assistantId);
    await append(grantStream(operation, scopeId), 'grant.given', {
      resourceType: operation, resourceId: scopeId, granteeKind: 'member', granteeId: 'bob',
      grantedBy: 'owner',
    });
    await write(assistantId, 'assistant_notes', 'detail-note');
  }
  await runner.run(computers);
  await runner.run(projection);
  const readable = await get(`${path('detail-memory_read', 'assistant_notes')}/facts/detail-note`);
  expect(readable.statusCode).toBe(200);
  expect(readable.json()).toMatchObject({ fact: { memoryId: 'detail-note' } });
  const writeOnly = await get(`${path('detail-memory_write', 'assistant_notes')}/facts/detail-note`);
  expect(writeOnly.statusCode).toBe(404);
  expect(writeOnly.json()).toEqual({ status: 'refused' });
});

it('keeps memory source links within the latest participation period',
  async function lateSourceLinks() {
    const conversationId = 'detail-late-source';
    const subject = `conversation-${conversationId}`;
    await append(subject, 'conversation.created', {
      conversationId, createdBy: 'owner', mode: 'group', participantIds: ['owner', 'admin'],
    });
    const messageData = { conversationId, authorId: 'owner', authorKind: 'human',
      ciphertext: 'AAAAAAAAAAAAAAAAAAAA', keyId: 'key:chat', contentType: 'text' };
    const older = await append(subject, 'message.posted', messageData);
    await append(`participation-${conversationId}`, 'participant.added', {
      conversationId, participantId: 'bob', addedBy: 'owner',
    });
    const newer = await append(subject, 'message.posted', messageData);
    const sources = [{ conversationId, messageId: older.id },
      { conversationId, messageId: newer.id }];
    await write('bob', 'person', 'detail-late-links', 'Readable fact', false, 'acme', sources);
    await runner.run(projection);
    await runner.run(conversations);
    const url = `${path('bob')}/facts/detail-late-links`;
    const response = await get(url);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ sources: [
      { status: 'refused' }, { status: 'available', reference: sources[1] },
    ] });
    expect(response.body).not.toContain(older.id);
  });

it('checks chat access first and looks up only the selected source message', async function boundedSources() {
  const conversationId = 'detail-source-only-chat';
  await append(`conversation-${conversationId}`, 'conversation.created', {
    conversationId, createdBy: 'bob', mode: 'direct', participantIds: ['bob', 'owner'],
  });
  const messageData = { conversationId, authorId: 'bob', authorKind: 'human',
    ciphertext: 'AAAAAAAAAAAAAAAAAAAA', keyId: 'key:chat', contentType: 'text' };
  const message = await append(`conversation-${conversationId}`, 'message.posted', messageData);
  for (let index = 0; index < 100; index++) {
    await append(`conversation-${conversationId}`, 'message.posted', messageData);
  }
  const sources = [{ conversationId, messageId: message.id }];
  await write('bob', 'person', 'detail-bounded', 'Readable sourced text', false, 'acme', sources);
  await runner.run(projection);
  await runner.run(conversations);
  const original = nats.store.readStream.bind(nats.store);
  async function* bounded(subject: string, from?: number, deadline?: number) {
    let count = 0;
    for await (const row of original(subject, from, deadline)) {
      if (subject === `conversation-${conversationId}`) {
        expect(++count).toBeLessThanOrEqual(1);
      }
      yield row;
    }
  }
  const readSpy = vi.spyOn(nats.store, 'readStream').mockImplementation(bounded);
  const querySpy = vi.spyOn(memory.db, 'query');
  try {
    const url = `${path('bob')}/facts/detail-bounded`;
    expect((await get(url)).json()).toMatchObject({ sources: [{ status: 'available',
      reference: sources[0] }] });
    const denied = { allowed: false, status: 'ok' as const };
    const permission = vi.spyOn(auth, 'conversation').mockResolvedValue(denied);
    querySpy.mockClear();
    let refused;
    try { refused = await get(url); }
    finally { permission.mockRestore(); }
    expect(refused.statusCode).toBe(200);
    expect(refused.json()).toMatchObject({ sources: [{ status: 'refused' }] });
    expect(refused.body).not.toContain(conversationId);
    for (const [sql] of querySpy.mock.calls) expect(sql).not.toContain('conversation_feed');
  } finally {
    readSpy.mockRestore();
    querySpy.mockRestore();
  }
});

it('hides missing messages and keeps readable facts available during source outages',
  async function missingAndUnavailableSources() {
    const sources = [{ conversationId: 'detail_chat', messageId: 'missing-message' }];
    await write('bob', 'person', 'detail-missing', 'Fact with a missing source', false, 'acme', sources);
    await runner.run(projection);
    await runner.run(conversations);
    const url = `${path('bob')}/facts/detail-missing`;
    const missing = await get(url);
    expect(missing.statusCode).toBe(200);
    expect(missing.json()).toMatchObject({ fact: { text: 'Fact with a missing source' },
      sources: [{ status: 'refused' }] });
    expect(missing.body).not.toContain('missing-message');
    const original = memory.db.query.bind(memory.db);
    async function unavailable<Row extends Record<string, unknown>>(sql: string, values?: unknown[]) {
      if (sql.includes('conversation_feed')) {
        throw new Error('Message lookup unavailable');
      }
      return original<Row>(sql, values);
    }
    const spy = vi.spyOn(memory.db, 'query').mockImplementation(unavailable);
    try {
      const response = await get(url);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ fact: { text: 'Fact with a missing source' },
        sources: [{ status: 'unavailable' }] });
      expect(response.body).not.toContain('detail_chat');
      expect(response.body).not.toContain('missing-message');
    } finally { spy.mockRestore(); }
  });

it('labels a departed member statement without exposing their identity or command',
  async function neutralStatement() {
    await append('member-statement-author', 'member.joined', {
      memberId: 'statement-author', role: 'member', email: 'author@example.test',
      displayName: 'Former author',
    });
    const sources = [{ memberId: 'statement-author', commandId: 'private-statement-command' }];
    await write('bob', 'person', 'detail-statement', 'A saved member statement', false, 'acme', sources);
    await append('member-statement-author', 'member.removed',
      { memberId: 'statement-author', removedBy: 'owner' });
    await runner.run(projection);
    const response = await get(`${path('bob')}/facts/detail-statement`);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ sources: [{ status: 'available',
      label: "a member's statement" }] });
    expect(response.body).not.toContain('statement-author');
    expect(response.body).not.toContain('private-statement-command');
    expect(response.body).not.toContain('memberId');
    expect(response.body).not.toContain('commandId');
  });

it('returns unavailable legacy metadata without decoding fact text', async function legacyQuarantine() {
  await write('bob', 'person', 'detail-legacy', 'Legacy private text');
  await runner.run(projection);
  // Match the empty metadata kept for an older write whose ownership could not be checked.
  await storage.queue.query(`UPDATE memory_facts SET content_status='quarantined',
    revision=NULL, kind=NULL, pinned=NULL WHERE memory_id=$1`, ['detail-legacy']);
  const response = await get(`${path('bob')}/facts/detail-legacy`);
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ status: 'unavailable', memoryId: 'detail-legacy',
    revision: null, reason: 'quarantined' });
  expect(response.body).not.toContain('Legacy private text');
  expect(response.json()).not.toHaveProperty('fact');
});

function remember(owner: string, kind: MemoryIdentity['scopeKind'], commandId: string,
  member = 'bob', extra: Record<string, unknown> = {}) {
  const session = { sub: `idp-${member}`, orgId: 'org-acme', roles: ['owner'],
    authTime: 1790856000, exp: 2000000000 };
  const headers = { cookie: `${config.cookieName}=${encodeSession(config, session)}`,
    origin: new URL(config.redirectUri).origin };
  const payload = { commandId, text: 'A human statement', kind: 'fact', pinned: false,
    expiresAt: null, sources: [], dependsOn: [], ...extra };
  return app.inject({ method: 'POST', url: `${path(owner, kind)}/facts`, headers, payload });
}
async function writeGrant(assistantId: string) {
  const scopeId = memoryScopeId('acme', 'assistant_notes', assistantId);
  await append(grantStream('memory_write', scopeId), 'grant.given', {
    resourceType: 'memory_write', resourceId: scopeId, granteeKind: 'member',
    granteeId: 'bob', grantedBy: 'owner',
  });
}

it('stores human facts with separate write rights and no administrative bypass', async function writes() {
  await append('team-write-sales', 'team.created',
    { teamId: 'write-sales', name: 'Writers', createdBy: 'owner' });
  await append('team-write-sales', 'team.member_added',
    { teamId: 'write-sales', memberId: 'bob', addedBy: 'owner' });
  for (const [assistantId, kind, ownerId] of [
    ['write-personal', 'personal', 'bob'], ['write-shared', 'team', 'write-sales'],
  ]) {
    await append(`assistant-${assistantId}`, 'assistant.created', { assistantId, kind, ownerId });
    const scopeId = memoryScopeId('acme', 'assistant_notes', assistantId!);
    await append(grantStream('memory_read', scopeId), 'grant.given', {
      resourceType: 'memory_read', resourceId: scopeId, granteeKind: 'member',
      granteeId: 'bob', grantedBy: 'owner',
    });
  }
  await runner.run(groups);
  await runner.run(computers);
  expect((await remember('bob', 'person', 'own-write')).statusCode).toBe(200);
  expect((await remember('write-sales', 'group', 'group-write')).statusCode).toBe(200);
  expect((await remember('write-personal', 'assistant_notes', 'read-only')).statusCode).toBe(404);
  await writeGrant('write-personal');
  await writeGrant('write-shared');
  for (const assistant of ['write-personal', 'write-shared']) {
    expect((await remember(assistant, 'assistant_notes', `notes-${assistant}`)).statusCode).toBe(200);
  }
  for (const member of ['owner', 'admin']) {
    expect((await remember('bob', 'person', `denied-${member}`, member)).statusCode).toBe(404);
    expect((await remember('write-shared', 'assistant_notes', `notes-denied-${member}`, member))
      .statusCode).toBe(404);
  }
  await runner.run(projection);
});
it('refuses private sources, shared preferences, forged statements and controls', async function inputs() {
  const privateSource = { sources: [{ conversationId: 'busy', messageId: 'private' }] };
  for (const [owner, kind] of [['write-sales', 'group'], ['write-shared', 'assistant_notes']] as const) {
    expect((await remember(owner, kind, `private-${owner}`, 'bob', privateSource)).statusCode).toBe(404);
    expect((await remember(owner, kind, `preference-${owner}`, 'bob', { kind: 'preference' }))
      .statusCode).toBe(422);
  }
  const forged = { sources: [{ memberId: 'owner', commandId: 'forged' }] };
  expect((await remember('bob', 'person', 'forged', 'bob', forged)).statusCode).toBe(404);
  for (const text of ['\u0001', '\u0000', '\r', 'x'.repeat(4097)]) {
    expect((await remember('bob', 'person', `invalid-${++count}`, 'bob', { text }))
      .statusCode).toBe(422);
  }
});
it('converges identical concurrent commands and conflicts on changed input', async function duplicate() {
  function send() { return remember('bob', 'person', 'concurrent'); }
  const replies = await Promise.all([send(), send()]);
  function receipt(response: Awaited<ReturnType<typeof send>>) {
    return response.json<{ memoryId: string }>();
  }
  const receipts = replies.map(receipt);
  // A pending caller checks status instead of submitting another append.
  await runner.run(projection);
  const original = await get(`${path('bob')}/changes/concurrent`);
  expect(original.json()).toMatchObject({ outcome: 'saved', revision: 1 });
  const saved = original.json<{ memoryId: string }>();
  for (let index = 0; index < receipts.length; index++) {
    const response = replies[index]!;
    if (response.statusCode === 503) {
      expect(receipts[index]).toEqual({ status: 'unavailable', reason: 'memory_unavailable' });
    } else {
      expect(receipts[index]).toMatchObject({ memoryId: saved.memoryId });
    }
  }
  expect((await send()).json()).toEqual(original.json());
  expect((await remember('bob', 'person', 'concurrent', 'bob', { pinned: true })).statusCode).toBe(409);
  const changed = await Promise.all([
    remember('bob', 'person', 'changed-race'),
    remember('bob', 'person', 'changed-race', 'bob', { text: 'Changed statement' }),
  ]);
  function status(response: Awaited<ReturnType<typeof send>>) {
    return response.statusCode;
  }
  const statuses = changed.map(status);
  expect(statuses).toContain(200);
  for (const status of statuses) expect([200, 409, 503]).toContain(status);
  await runner.run(projection);
  expect((await get(`${path('bob')}/changes/concurrent`, 'admin')).statusCode).toBe(404);
  expect((await get(`${path('bob')}/changes/unseen`)).json()).toMatchObject({ outcome: 'unknown' });

});
it.each(['unavailable', 'conflict'] as const)(
  'reconciles the same key reference after append returns %s', async function lost(status) {
  const original = nats.store.append.bind(nats.store);
  async function lose(command: Parameters<typeof original>[0]) {
    await original(command);
    if (status === 'conflict') return { status: 'conflict' as const };
    return { status: 'unavailable' as const, cause: new Error('Reply lost') };
  }
  const spy = vi.spyOn(nats.store, 'append').mockImplementation(lose);
  let response;
  try {
    response = await remember('bob', 'person', `lost-reply-${status}`);
    const outcome = status === 'conflict' ? 'saved' : 'unknown';
    expect(response.json()).toMatchObject({ outcome });
    expect(spy).toHaveBeenCalledTimes(1);
  } finally { spy.mockRestore(); }
  expect((await get(`${path('bob')}/changes/lost-reply-${status}`)).statusCode).toBe(503);
  await runner.run(projection);
  const checked = await get(`${path('bob')}/changes/lost-reply-${status}`);
  expect(checked.json()).toMatchObject({ outcome: 'saved' });
  expect((await remember('bob', 'person', `lost-reply-${status}`)).json()).toEqual(checked.json());

});
it('keeps keys while unavailable and reconciles unused keys after definite failure', async function failure() {
  const unavailable = { status: 'unavailable' as const, cause: new Error('Unavailable') };
  const spy = vi.spyOn(nats.store, 'append').mockResolvedValue(unavailable);
  try {
    const response = await remember('bob', 'person', 'unavailable-write');
    expect(response.json()).toMatchObject({ outcome: 'unknown' });
    const memoryId = response.json<{ memoryId: string }>().memoryId;
    const scopeId = memoryScopeId('acme', 'person', 'bob');
    const identity = { silo: 'acme', scopeId, scopeKind: 'person' as const,
      ownerId: 'bob', memoryId, revision: 1 };
    expect(keys.provision(identity)).toMatch(/^key:/u);
    expect((await remember('bob', 'person', 'unavailable-write')).json())
      .toMatchObject({ outcome: 'unknown' });
    expect(spy).toHaveBeenCalledTimes(1);
  } finally { spy.mockRestore(); }
  const rejected = { status: 'conflict' as const };
  const failed = vi.spyOn(nats.store, 'append').mockResolvedValue(rejected);
  let response;
  try { response = await remember('bob', 'person', 'failed-write'); }
  finally { failed.mockRestore(); }
  const memoryId = response.json<{ memoryId: string }>().memoryId;
  const scopeId = memoryScopeId('acme', 'person', 'bob');
  const identity = { silo: 'acme', scopeId, scopeKind: 'person' as const,
    ownerId: 'bob', memoryId, revision: 1 };
  expect(response.statusCode).toBe(409);
  expect(function provisionDeleted() { keys.provision(identity); }).toThrow('destroyed');
});
it('refuses an unapplied write revoke', async function revokedWrite() {
  const scopeId = memoryScopeId('acme', 'assistant_notes', 'write-shared');
  await append(grantStream('memory_write', scopeId), 'grant.revoked', {
    resourceType: 'memory_write', resourceId: scopeId, granteeKind: 'member',
    granteeId: 'bob', revokedBy: 'owner',
  }, false);
  expect((await remember('write-shared', 'assistant_notes', 'unapplied-revoke')).statusCode).toBe(503);
});
it('loads long history before the write time limit and ignores chat activity', async function writeActivity() {
  const original = nats.store.readStream.bind(nats.store);
  const originalHead = nats.store.head.bind(nats.store);
  async function activeHead(subject?: string, deadline?: number) {
    const position = await originalHead(subject, deadline);
    if (subject === undefined) {
      await append('conversation-busy', 'message.posted', { conversationId: 'busy',
        authorId: 'bob', authorKind: 'human', ciphertext: 'AAAAAAAAAAAAAAAAAAAA',
        keyId: 'key:chat', contentType: 'text' });
    }
    return position;
  }
  const headSpy = vi.spyOn(nats.store, 'head').mockImplementation(activeHead);
  let once = false;
  async function* delayed(subject: string, from?: number, deadline?: number) {
    if (subject.startsWith('scope-') && !once) {
      once = true;
      await new Promise(function pause(resolve) { setTimeout(resolve, 2100); });
    }
    expect(subject).not.toMatch(/^conversation-/u);
    yield* original(subject, from, deadline);
  }
  const spy = vi.spyOn(nats.store, 'readStream').mockImplementation(delayed);
  try { expect((await remember('bob', 'person', 'long-history')).statusCode).toBe(200); }
  finally { spy.mockRestore(); headSpy.mockRestore(); }
  await runner.run(projection);
});


it('reconciles a prepared key and its temporary copy after restart', async function restartCleanup() {
  const unavailable = { status: 'unavailable' as const, cause: new Error('Unavailable') };
  const spy = vi.spyOn(nats.store, 'append').mockResolvedValue(unavailable);
  let response;
  try { response = await remember('bob', 'person', 'restart-prepared'); }
  finally { spy.mockRestore(); }
  const memoryId = response.json<{ memoryId: string }>().memoryId;
  const journalPath = `${directory}/command-${memoryId}.json`;
  const raw: unknown = JSON.parse(await readFile(journalPath, 'utf8'));
  const entry = z.record(z.string(), z.unknown()).parse(raw);
  // Restore the disk state just before append was attempted, as after a process crash.
  entry['stage'] = 'prepared';
  await writeFile(journalPath, JSON.stringify(entry));
  const identity = { silo: 'acme', scopeId: memoryScopeId('acme', 'person', 'bob'),
    scopeKind: 'person' as const, ownerId: 'bob', memoryId, revision: 1 };
  const reference = keys.provision(identity).slice(4);
  await copyFile(`${directory}/${reference}`, `${directory}/${reference}-pending`);
  await app.close();
  app = buildServer(config, { memory });
  async function resolvedFailure() {
    expect((await get(`${path('bob')}/changes/restart-prepared`)).json())
      .toMatchObject({ outcome: 'failed' });
  }
  await vi.waitFor(resolvedFailure, { timeout: 5000, interval: 100 });
  expect(function deleted() { keys.provision(identity); }).toThrow('destroyed');
  await expect(access(`${directory}/${reference}-pending`)).rejects.toThrow();
  expect((await remember('bob', 'person', 'unavailable-write')).json())
    .toMatchObject({ outcome: 'failed' });
});

it('conflicts when a reconciled command has different saved input', async function changedSaved() {
  const original = nats.store.append.bind(nats.store);
  async function conflict(command: Parameters<typeof original>[0]) {
    const record = memoryWrittenEventSchema.parse(command.event);
    if (!('schemaVersion' in record.data)) throw new Error('Expected current memory');
    const changedData = { ...record.data, pinned: true };
    const changedEvent = { ...record, data: changedData };
    const changedCommand = { ...command, event: changedEvent };
    await original(changedCommand);
    return { status: 'conflict' as const };
  }
  const spy = vi.spyOn(nats.store, 'append').mockImplementation(conflict);
  try {
    expect((await remember('bob', 'person', 'different-saved-input')).statusCode).toBe(409);
  } finally { spy.mockRestore(); }
  await runner.run(projection);
});


it('checks write permission before content checks or taking a command lock', async function permissionFirst() {
  const lock = vi.spyOn(memory.db, 'lock');
  const read = vi.spyOn(nats.store, 'readStream');
  const invalid = { kind: 'preference', dependsOn: [{
    scopeId: memoryScopeId('acme', 'group', 'write-sales'), memoryId: 'missing', revision: 1,
  }] };
  try {
    for (const owner of ['write-sales', 'unknown']) {
      const response = await remember(owner, 'group', `forbidden-${owner}`, 'admin', invalid);
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ status: 'refused' });
    }
    expect(lock).not.toHaveBeenCalled();
    for (const [subject] of read.mock.calls) expect(subject).not.toMatch(/^scope-/u);
  } finally {
    lock.mockRestore();
    read.mockRestore();
  }
});

it.each(['other_scope', 'stale', 'destroyed', 'expired'] as const)(
  'refuses a %s dependency without appending', async function dependencyRefusal(kind) {
    const memoryId = `dependency-${kind}`;
    const record = await write('bob', 'person', memoryId);
    const scopeId = memoryScopeId('acme', 'person', 'bob');
    const identity = { silo: 'acme', scopeId, scopeKind: 'person' as const,
      ownerId: 'bob', memoryId, revision: 1 };
    if (kind === 'destroyed') keys.delete(identity);
    if (kind === 'expired') {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
      const saved = memoryWrittenEventSchema.parse(record);
      if (!('schemaVersion' in saved.data)) throw new Error('Expected current memory');
      const data = { ...saved.data, expiresAt: '2029-01-01T00:00:00Z' };
      const updated = { ...saved, id: `expired-${memoryId}`, commandId: `expired-${memoryId}`, data };
      const command = { event: updated, expectedSequence: await nats.store.head(saved.subject),
        historyChecked: true as const };
      expect((await nats.store.append(command)).status).toBe('appended');
    }
    const dependency = { scopeId, memoryId, revision: 1 };
    if (kind === 'other_scope') dependency.scopeId = memoryScopeId('acme', 'group', 'sales');
    if (kind === 'stale') dependency.revision = 2;
    const spy = vi.spyOn(nats.store, 'append');
    try {
      const response = await remember('bob', 'person', `refuse-${kind}`, 'bob',
        { dependsOn: [dependency] });
      expect(response.statusCode).toBe(409);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      vi.useRealTimers();
    }
  });

it('ignores other event types when checking live dependencies', async function otherRows() {
  const record = await write('bob', 'person', 'dependency-live');
  const scopeId = memoryScopeId('acme', 'person', 'bob');
  const original = nats.store.readStream.bind(nats.store);
  async function* withOtherRow(subject: string, from?: number, deadline?: number) {
    if (subject === `scope-${scopeId}`) {
      yield { sequence: 0, event: { ...record, type: 'memory.forgotten', data: {} } };
    }
    yield* original(subject, from, deadline);
  }
  const spy = vi.spyOn(nats.store, 'readStream').mockImplementation(withOtherRow);
  try {
    const dependency = { scopeId, memoryId: 'dependency-live', revision: 1 };
    expect((await remember('bob', 'person', 'dependency-other-row', 'bob',
      { dependsOn: [dependency] })).statusCode).toBe(200);
  } finally { spy.mockRestore(); }
});

it('refuses past expiry and oversized commands', async function limitsBeforeKeys() {
  expect((await remember('bob', 'person', 'past-expiry', 'bob',
    { expiresAt: '2020-01-01T00:00:00Z' })).statusCode).toBe(422);
  const extra = { text: 'x'.repeat(17000) };
  expect((await remember('bob', 'person', 'oversized-body', 'bob', extra)).statusCode).toBe(422);
});

it('checks the complete event size before creating a revision key', async function eventSize() {
  const scopeId = memoryScopeId('acme', 'person', 'bob');
  const dependsOn = [];
  for (let index = 0; index < 32; index++) {
    const memoryId = `${String(index).padStart(2, '0')}_${'x'.repeat(197)}`;
    await write('bob', 'person', memoryId);
    dependsOn.push({ scopeId, memoryId, revision: 1 });
  }
  const sources = [];
  const commandId = 'event-size_' + 'c'.repeat(180);
  for (let index = 0; index < 8; index++) sources.push({ memberId: 'bob', commandId });
  const tooLarge = { text: 'x'.repeat(4096), sources, dependsOn };
  expect((await remember('bob', 'person', commandId, 'bob', tooLarge)).statusCode).toBe(422);
  expect((await remember('bob', 'person', commandId)).statusCode).toBe(200);
});

it('refuses a wrong Origin before doing memory work', async function origin() {
  const session = { sub: 'idp-bob', orgId: 'org-acme', roles: ['owner'],
    authTime: 1790856000, exp: 2000000000 };
  const headers = { cookie: `${config.cookieName}=${encodeSession(config, session)}`,
    origin: 'https://other.example.test' };
  const spy = vi.spyOn(nats.store, 'readStream');
  try {
    const response = await app.inject({ method: 'POST', url: `${path('bob')}/facts`,
      headers, payload: {} });
    expect(response.statusCode).toBe(403);
    expect(spy).not.toHaveBeenCalled();
  } finally { spy.mockRestore(); }
});

it.each(['team', 'grant', 'assistant'] as const)(
  'refuses a %s change during the final write check', async function changedAuthority(kind) {
    const assistantId = `write-changing-${kind}`;
    await append('team-changing', 'team.created',
      { teamId: 'changing', name: 'Changing', createdBy: 'owner' });
    await append('team-changing', 'team.member_added',
      { teamId: 'changing', memberId: 'bob', addedBy: 'owner' });
    await append(`assistant-${assistantId}`, 'assistant.created',
      { assistantId, kind: 'team', ownerId: 'changing' });
    await writeGrant(assistantId);
    await runner.run(groups);
    await runner.run(computers);
    const scopeId = memoryScopeId('acme', 'assistant_notes', assistantId);
    const subject = { team: 'team-changing', grant: grantStream('memory_write', scopeId),
      assistant: `assistant-${assistantId}` }[kind];
    const original = nats.store.head.bind(nats.store);
    let checks = 0;
    async function move(target?: string, deadline?: number) {
      const position = await original(target, deadline);
      if (target === subject && ++checks === 1) {
        if (kind === 'team') {
          await append(subject, 'team.member_removed',
            { teamId: 'changing', memberId: 'bob', removedBy: 'owner' }, false);
        } else if (kind === 'assistant') {
          await append(subject, 'assistant.settings_changed', { assistantId, changedBy: 'owner',
            active: false, changedFields: ['active'] }, false);
        } else {
          await append(subject, 'grant.revoked', { resourceType: 'memory_write',
            resourceId: scopeId, granteeKind: 'member', granteeId: 'bob', revokedBy: 'owner' }, false);
        }
        return original(target, deadline);
      }
      return position;
    }
    const spy = vi.spyOn(nats.store, 'head').mockImplementation(move);
    try {
      expect((await remember(assistantId, 'assistant_notes', `changed-${kind}`)).statusCode)
        .toBe(503);
    } finally { spy.mockRestore(); }
  });

it('lets a notes writer check their command without a read grant', async function writerStatus() {
  await append('assistant-write-only', 'assistant.created',
    { assistantId: 'write-only', kind: 'personal', ownerId: 'bob' });
  await writeGrant('write-only');
  await runner.run(computers);
  expect((await remember('write-only', 'assistant_notes', 'write-only-command')).statusCode).toBe(200);
  await runner.run(projection);
  expect((await get(`${path('write-only', 'assistant_notes')}/facts`)).statusCode).toBe(404);
  expect((await get(`${path('write-only', 'assistant_notes')}/changes/write-only-command`)).json())
    .toMatchObject({ outcome: 'saved' });
});

it('keeps no text or text hash in a journal and removes resolved records', async function journalPrivacy() {
  const unavailable = { status: 'unavailable' as const, cause: new Error('Reply lost') };
  const spy = vi.spyOn(nats.store, 'append').mockResolvedValue(unavailable);
  let response;
  try { response = await remember('bob', 'person', 'journal-private'); }
  finally { spy.mockRestore(); }
  const memoryId = response.json<{ memoryId: string }>().memoryId;
  const journalPath = `${directory}/command-${memoryId}.json`;
  const raw = await readFile(journalPath, 'utf8');
  expect(raw).not.toContain('A human statement');
  const entry = z.object({ inputDigest: z.string() }).parse(JSON.parse(raw));
  const hash = await import('node:crypto');
  const input = { kind: 'fact', pinned: false, expiresAt: null,
    sources: [{ memberId: 'bob', commandId: 'journal-private' }], dependsOn: [],
    commandId: 'journal-private', text: 'A human statement' };
  const fingerprint = hash.createHash('sha256');
  fingerprint.update(JSON.stringify(input));
  const digest = fingerprint.digest('hex');
  expect(entry.inputDigest).not.toBe(digest);
  await new Promise(function appendWindow(resolve) { setTimeout(resolve, 2100); });
  await reconcileCommands(memory);
  expect((await get(`${path('bob')}/changes/journal-private`)).json())
    .toMatchObject({ outcome: 'failed' });
  await expect(access(journalPath)).rejects.toThrow();
  const saved = await remember('bob', 'person', 'journal-saved');
  const savedId = saved.json<{ memoryId: string }>().memoryId;
  await expect(access(`${directory}/command-${savedId}.json`)).rejects.toThrow();
});

it('starts despite damaged journals and a failed recovery read', async function bootRecovery() {
  const badPath = `${directory}/command-${'f'.repeat(64)}.json`;
  await writeFile(badPath, '{damaged');
  await app.close();
  const spy = vi.spyOn(nats.store, 'readStream').mockImplementation(brokenRead);
  async function* brokenRead(): AsyncGenerator<never> {
    await Promise.reject(new Error('NATS unavailable'));
    yield* [];
  }
  try {
    app = buildServer(config, { memory });
    await app.ready();
  } finally {
    spy.mockRestore();
    await rm(badPath);
  }
});


it('accepts accessible personal chat messages and refuses missing or private messages',
  async function personalSources() {
    for (const [conversationId, participantIds] of [
      ['memory-source', ['bob', 'owner']], ['memory-private', ['owner', 'admin']],
    ] as const) {
      await append(`conversation-${conversationId}`, 'conversation.created',
        { conversationId, mode: 'direct', participantIds, createdBy: participantIds[0] });
    }
    const posted = await append('conversation-memory-source', 'message.posted', {
      conversationId: 'memory-source', authorId: 'bob', authorKind: 'human',
      ciphertext: 'AAAAAAAAAAAAAAAAAAAA', keyId: 'key:chat', contentType: 'text',
    });
    await runner.run(conversations);
    const original = nats.store.readStream.bind(nats.store);
    async function* bounded(subject: string, from?: number, deadline?: number) {
      let rows = 0;
      for await (const row of original(subject, from, deadline)) {
        if (subject.startsWith('conversation-')) expect(++rows).toBeLessThanOrEqual(1);
        yield row;
      }
    }
    const spy = vi.spyOn(nats.store, 'readStream').mockImplementation(bounded);
    const lock = memory.db.lock!.bind(memory.db);
    let locked = false;
    async function trackedLock<T>(name: string, work: (db: import('@opencrane/projections').Db) => Promise<T>) {
      async function tracked(db: import('@opencrane/projections').Db) {
        locked = true;
        try { return await work(db); }
        finally { locked = false; }
      }
      return lock(name, tracked);
    }
    const lockSpy = vi.spyOn(memory.db, 'lock').mockImplementation(trackedLock);
    const query = memory.db.query.bind(memory.db);
    async function outsideLock<Row extends Record<string, unknown>>(sql: string, values?: unknown[]) {
      if (sql.includes('conversation_feed')) expect(locked).toBe(false);
      return query<Row>(sql, values);
    }
    const querySpy = vi.spyOn(memory.db, 'query').mockImplementation(outsideLock);
    try {
      const accessible = { sources: [{ conversationId: 'memory-source', messageId: posted.id }] };
      expect((await remember('bob', 'person', 'chat-source', 'bob', accessible)).statusCode).toBe(200);
      const missing = { sources: [{ conversationId: 'memory-source', messageId: 'missing' }] };
      expect((await remember('bob', 'person', 'missing-source', 'bob', missing)).statusCode).toBe(404);
      const privateMessage = { sources: [{ conversationId: 'memory-private', messageId: 'private' }] };
      expect((await remember('bob', 'person', 'private-source', 'bob', privateMessage)).statusCode).toBe(404);
    } finally {
      spy.mockRestore(); lockSpy.mockRestore(); querySpy.mockRestore();
    }
  });

it('refuses a busy command lock promptly and keeps the database usable', async function busyLock() {
  const crypto = await import('node:crypto');
  const hash = crypto.createHash('sha256');
  hash.update(JSON.stringify(['acme', 'human', 'bob', memoryScopeId('acme', 'person', 'bob'),
    'busy-command']));
  const reference = hash.digest('hex');
  const client = await storage.queue.connect();
  const name = `opencrane:projection:memory-command:${reference}`;
  await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [name]);
  let pending;
  try {
    pending = remember('bob', 'person', 'busy-command');
    function timeout(): Promise<never> {
      return new Promise(function wait(_resolve, reject) {
        setTimeout(function fail() { reject(new Error('Command waited for its lock')); }, 1500);
      });
    }
    const response = await Promise.race([pending, timeout()]);
    expect([409, 503]).toContain(response.statusCode);
    expect((await storage.queue.query('SELECT 1')).rows).toHaveLength(1);
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [name]);
    client.release();
    await pending;
  }
});


it('resolves an unknown saved command across restart without resending', async function unknownRestart() {
  const original = nats.store.append.bind(nats.store);
  async function lostReply(command: Parameters<typeof original>[0]) {
    await original(command);
    return { status: 'unavailable' as const, cause: new Error('Reply lost') };
  }
  const spy = vi.spyOn(nats.store, 'append').mockImplementation(lostReply);
  let response;
  try { response = await remember('bob', 'person', 'unknown-restart'); }
  finally { spy.mockRestore(); }
  expect(response.json()).toMatchObject({ outcome: 'unknown' });
  const memoryId = response.json<{ memoryId: string }>().memoryId;
  await app.close();
  await new Promise(function appendWindow(resolve) { setTimeout(resolve, 2100); });
  app = buildServer(config, { memory });
  await app.ready();
  await runner.run(projection);
  const appendSpy = vi.spyOn(nats.store, 'append');
  try {
    expect((await get(`${path('bob')}/changes/unknown-restart`)).json())
      .toMatchObject({ outcome: 'saved', memoryId });
    await expect(access(`${directory}/command-${memoryId}.json`)).rejects.toThrow();
    expect(appendSpy).not.toHaveBeenCalled();
  } finally { appendSpy.mockRestore(); }
});
