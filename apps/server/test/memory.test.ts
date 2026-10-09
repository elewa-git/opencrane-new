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
import type { ModelAccessOptions } from '../src/models/access-routes.ts';
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
let memory: ModelAccessOptions;
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
  memory = { silo: 'acme', store: nats.store, db, binding,
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
    const unavailable = { allowed: false, status: 'unavailable' as const };
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
  const original = auth.applied;
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
      return Promise.resolve(null);
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
