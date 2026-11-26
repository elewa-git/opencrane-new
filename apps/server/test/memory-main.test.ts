import { bridgeProcessSettings } from './support/bridge-process.ts';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, stat } from 'node:fs/promises';
import { afterEach, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { encodeSession, loadAuthConfig } from '@opencrane/auth';
import { createStore, grantStream, memberAuthorisation } from '@opencrane/authz';
import { databases, openfga, until } from '@opencrane/authz/testing';
import { appendEvent, event, natsFixture } from '@opencrane/event-store/testing';
import { createLogger } from '@opencrane/observability';
import { seedOwnership } from '@opencrane/models';
import { members, memoryScopeId, pgDb, ProjectionRunner, groups, computers, conversations } from '@opencrane/projections';
import { objectId, TupleClient } from '../../../libs/authz/src/client.ts';
import { grantPackageReads } from '../../../infra/package/package-database.ts';
import { lockPackageTestRoles } from '../../../infra/package/pilot-restore-postgres-fixture.ts';
import { startServer, TEST_OIDC_ENV, type RunningServer } from './support/process.ts';

let nats: Awaited<ReturnType<typeof natsFixture>>;
let storage: Awaited<ReturnType<typeof databases>>;
let fga: Awaited<ReturnType<typeof openfga>>;
let server: RunningServer | undefined;
let directory: string;
let worker: ChildProcess | undefined;
let workerStopped: Promise<unknown[]> | undefined;
let workerOutput = '';
let projectionPool: Pool | undefined;
let rolePool: Pool | undefined;
let roleSession: PoolClient | undefined;
const fixtureRoles: string[] = [];

afterEach(async function cleanup() {
  await server?.stop();
  if (worker && worker.exitCode === null && worker.signalCode === null) {
    worker.kill('SIGTERM');
  }
  await workerStopped;
  try {
    await projectionPool?.end();
    projectionPool = undefined;
    await storage?.close();
  } finally {
    await releaseDatabaseRoles();
  }
  await fga?.close();
  await nats?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function setup(applyOwnershipSeed = true, isolatedMemory = false) {
  workerOutput = '';
  nats = await natsFixture();
  storage = await databases();
  fga = await openfga();
  directory = await mkdtemp('/tmp/memory-main-');
  await mkdir(`${directory}/memory-keys`, { mode: 0o700 });
  await mkdir(`${directory}/personal-keys`, { mode: 0o700 });
  const binding = await createStore(fga.apiUrl, 'acme');
  const bridge = await bridgeProcessSettings(directory);
  const roles = await databaseRoles(isolatedMemory);
  const env = {
    ...(isolatedMemory ? { MEMORY_PROJECTION_SCHEMA: 'opencrane_memory' } : {}),
    ...bridge, ...TEST_OIDC_ENV, ...nats.env(), SILO_ID: 'acme', DATABASE_URL: roles.server,
    OIDC_EXPECTED_ORG_ID: 'org-acme', OPENFGA_API_URL: binding.apiUrl,
    OPENFGA_STORE_ID: binding.storeId, OPENFGA_MODEL_ID: binding.authorizationModelId,
    MEMORY_KEY_DIRECTORY: `${directory}/memory-keys`,
    PERSONAL_KEY_DIRECTORY: `${directory}/personal-keys`, CONVERSATION_KEYS_DIR: '',
  };
  const db = pgDb(projectionPool ?? storage.queue);
  const runner = new ProjectionRunner(db, nats.reader, createLogger('memory-main'));
  for (const projection of [members, groups, computers, conversations]) {
    await runner.initialise(projection);
  }
  startMemoryWorker(env, roles.projection);
  function ready() { return memoryReady(isolatedMemory); }
  await until(ready);
  expect(await nats.store.head()).toBe(0);
  server = await startServer(env);
  const owner = {
    ...event('first-owner', 'member-bootstrap-owner', 'silo.owner_bootstrapped'),
    silo: 'acme', principal: { kind: 'human' as const, id: 'alice' },
    data: { memberId: 'bootstrap-owner', role: 'owner', email: 'alice@example.test',
      displayName: 'Alice', identity: { issuer: env.OIDC_ISSUER_URL, sub: 'alice' } },
  };
  expect((await nats.store.append({ event: owner, expectedSequence: 0 })).status)
    .toBe('appended');
  await seedOwnership(nats.store, 'acme');
  const auth = memberAuthorisation(binding);
  await auth.handler.handle(owner, db);
  async function applyOwnership() {
    for await (const row of nats.store.readStream('ownership-acme')) {
      await auth.handler.handle(row.event, db);
    }
  }
  if (applyOwnershipSeed) await applyOwnership();
  await runner.run(members);
  // Leave the new assistant awaiting its permission worker, as during account setup.
  const assistant = { ...event('new-assistant', 'assistant-personal', 'assistant.created'),
    silo: 'acme', data: { assistantId: 'personal', kind: 'personal', ownerId: 'bootstrap-owner' } };
  expect((await nats.store.append({ event: assistant, expectedSequence: 0 })).status)
    .toBe('appended');
  const config = loadAuthConfig(env);
  const now = Math.floor(Date.now() / 1000);
  const session = { sub: 'alice', orgId: 'org-acme', roles: [], authTime: now, exp: now + 300 };
  const headers = { cookie: `${config.cookieName}=${encodeSession(config, session)}`,
    origin: 'https://app.example.test', 'content-type': 'application/json' };
  const origin = `http://127.0.0.1:${server.port}`;
  return { headers, origin, env, assistant, auth, db, binding, applyOwnership, runner };
}

async function databaseRoles(isolatedMemory: boolean) {
  const base = storage.queue.options.connectionString!;
  if (!isolatedMemory) {
    return { server: base, projection: base };
  }
  await claimDatabaseRoles(base);
  const baseAddress = new URL(base);
  const database = baseAddress.pathname.slice(1);
  if (!/^authz_[a-f0-9]+$/u.test(database)) {
    throw new Error('Expected the disposable Memory fixture database');
  }
  await storage.queue.query(`ALTER DATABASE ${database} OWNER TO projection`);
  const projection = withRole(base, 'projection');
  const server = withRole(base, 'server');
  await grantPackageReads(projection);
  projectionPool = new Pool({ connectionString: projection });
  return { server, projection };
}

async function claimDatabaseRoles(address: string) {
  const database = new URL(address);
  database.pathname = '/postgres';
  const connectionString = process.env['PG_TEST_URL'] ?? database.href;
  rolePool = new Pool({ connectionString });
  roleSession = await rolePool.connect();
  // Use the restore tests' lock while the shared database has these fixed role names.
  await lockPackageTestRoles(roleSession);
  for (const role of ['projection', 'server']) {
    const existing = await roleSession.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [role]);
    if (existing.rows.length === 0) {
      await roleSession.query(`CREATE ROLE ${role} NOLOGIN`);
      fixtureRoles.push(role);
    }
  }
}

async function releaseDatabaseRoles() {
  const session = roleSession;
  const pool = rolePool;
  roleSession = undefined;
  rolePool = undefined;
  try {
    // Drop the fixture database first, since its tables and grants refer to these roles.
    for (const role of fixtureRoles.splice(0)) {
      await session?.query(`DROP ROLE ${role}`);
    }
  } finally {
    session?.release();
    await pool?.end();
  }
}

function withRole(address: string, role: 'projection' | 'server') {
  const url = new URL(address);
  url.searchParams.set('options', `-c role=${role}`);
  return url.href;
}

function startMemoryWorker(env: NodeJS.ProcessEnv, databaseUrl: string) {
  const args = ['--experimental-strip-types', 'apps/ops/src/worker.ts', 'memory'];
  const workerEnv: NodeJS.ProcessEnv = {
    ...process.env, ...env, ...nats.env('projection'), LOG_LEVEL: 'info', DATABASE_URL: databaseUrl,
  };
  worker = spawn(process.execPath, args, { env: workerEnv });
  function collect(chunk: Buffer) {
    workerOutput += chunk.toString();
  }
  worker.stdout?.on('data', collect);
  worker.stderr?.on('data', collect);
  workerStopped = once(worker, 'exit');
}

async function memoryReady(isolatedMemory = false) {
  if (!worker || worker.exitCode !== null || worker.signalCode !== null) {
    throw new Error(`Memory worker stopped: ${workerOutput}`);
  }
  const table = isolatedMemory ? 'opencrane_memory.projection_checkpoints' : 'projection_checkpoints';
  const relation = await storage.queue.query<{ name: string | null }>(
    'SELECT to_regclass($1) AS name', [table]);
  if (!relation.rows[0]?.name) {
    return false;
  }
  const result = await storage.queue.query<{ sequence: string }>(
    `SELECT sequence FROM ${table} WHERE name='memory'`);
  const projectedPosition = Number(result.rows[0]?.sequence);
  const savedPosition = await nats.store.head();
  return projectedPosition === savedPosition;
}

function isolatedMemoryIsCurrent() {
  return memoryReady(true);
}

it('loads empty personal memory, saves a fact and recalls it through the dev-stack entrypoint',
  async function firstMemory() {
    const { origin, headers, env } = await setup(true, true);
    const ordinary = await storage.queue.query("SELECT to_regclass('public.memory_facts') AS name");
    expect(ordinary.rows).toEqual([{ name: null }]);
    const schemaOwner = await storage.queue.query(
      "SELECT nspowner::regrole::text AS name FROM pg_namespace WHERE nspname='opencrane_memory'");
    expect(schemaOwner.rows).toEqual([{ name: 'projection' }]);
    const scopes = await fetch(`${origin}/api/memory/scopes?assistantId=personal`, { headers });
    const scopesBody: unknown = await scopes.json();
    expect({ status: scopes.status, body: scopesBody }, server?.stdout()).toMatchObject({ status: 200,
      body: { scopes: [{ scopeKind: 'person', ownerId: 'bootstrap-owner', canWrite: true }] } });
    const scopeId = memoryScopeId('acme', 'person', 'bootstrap-owner');
    const path = `${origin}/api/memory/${scopeId}/facts`;
    const empty = await fetch(path, { headers });
    expect(empty.status).toBe(200);
    expect(await empty.json()).toMatchObject({ facts: [], returnedCount: 0 });
    const input = { commandId: 'first-fact', text: 'I prefer jasmine tea', kind: 'preference',
      pinned: false, expiresAt: null, sources: [], dependsOn: [] };
    const saved = await fetch(path, { method: 'POST', headers, body: JSON.stringify(input) });
    const savedBody: unknown = await saved.json();
    expect({ status: saved.status, body: savedBody }).toMatchObject({ status: 200,
      body: { outcome: 'saved', revision: 1 } });
    await until(isolatedMemoryIsCurrent);
    const recalled = await fetch(`${path}?q=jasmine`, { headers });
    expect(recalled.status).toBe(200);
    expect(await recalled.json()).toMatchObject({ returnedCount: 1,
      facts: [{ text: 'I prefer jasmine tea', revision: 1 }] });
    expect((await stat(`${directory}/memory-keys`)).mode & 0o777).toBe(0o700);
    await server?.stop();
    server = await startServer(env);
    const restartedPath = `http://127.0.0.1:${server.port}/api/memory/${scopeId}/facts?q=jasmine`;
    const retained = await fetch(restartedPath, { headers });
    expect(retained.status).toBe(200);
    expect(await retained.json()).toMatchObject({ returnedCount: 1,
      facts: [{ text: 'I prefer jasmine tea', revision: 1 }] });
  }, 60_000);

it('opens onboarding alongside Memory and saves the first answer with an empty key folder',
  async function firstOnboarding() {
    const { origin, headers, env } = await setup();
    const entryPath = '/api/onboarding/entry';
    const first = await fetch(origin + entryPath, { headers });
    expect(first.status).toBe(200);
    expect(first.headers.get('cache-control')).toBe('no-store');
    expect(await first.json()).toEqual({ next: 'survey' });

    const scopes = await fetch(origin + '/api/memory/scopes', { headers });
    expect(scopes.status).toBe(200);
    const answers = { step: 1, preferredName: 'Alice', pronouns: null };
    const input = { operation: 'save_step', commandId: 'first-step', generation: 1,
      expectedPosition: 0, answers };
    const saved = await fetch(origin + '/api/onboarding/survey', {
      method: 'POST', headers, body: JSON.stringify(input),
    });
    expect(saved.status).toBe(200);

    await server?.stop();
    server = await startServer(env);
    const reopenedOrigin = `http://127.0.0.1:${server.port}`;
    const progress = await fetch(reopenedOrigin + '/api/onboarding', { headers });
    expect(progress.status).toBe(200);
    expect(await progress.json()).toMatchObject({
      state: 'survey', survey: { nextStep: 2, steps: [{ answers }] },
    });
  }, 60_000);

it('keeps granted notes unavailable until the assistant permissions are applied',
  async function pendingNotePermissions() {
    const { origin, headers, assistant, auth, db } = await setup();
    const scopeId = memoryScopeId('acme', 'assistant_notes', 'personal');
    const subject = grantStream('memory_read', scopeId);
    const grant = { ...event('notes-read', subject, 'grant.given'), silo: 'acme',
      data: { resourceType: 'memory_read', resourceId: scopeId, granteeKind: 'member',
        granteeId: 'bootstrap-owner', grantedBy: 'bootstrap-owner' } };
    expect((await nats.store.append({ event: grant, expectedSequence: 0 })).status)
      .toBe('appended');
    await auth.handler.handle(grant, db);
    const path = `${origin}/api/memory/scopes?assistantId=personal`;
    const pending = await fetch(path, { headers });
    expect(pending.status).toBe(503);
    expect(await pending.json()).toEqual({ status: 'unavailable', reason: 'memory_unavailable' });
    await auth.handler.handle(assistant, db);
    const available = await fetch(path, { headers });
    expect(available.status).toBe(200);
    expect(await available.json()).toMatchObject({ scopes: [
      { scopeKind: 'person', ownerId: 'bootstrap-owner' },
      { scopeKind: 'assistant_notes', ownerId: 'personal', canRead: true, canWrite: false },
    ] });
  }, 60_000);

it('identifies pending ownership permissions and loads personal memory after they apply',
  async function pendingOwnershipPermissions() {
    const { origin, headers, applyOwnership } = await setup(false);
    const scopeId = memoryScopeId('acme', 'person', 'bootstrap-owner');
    const paths = ['/api/memory/scopes', `/api/memory/${scopeId}/facts`,
      `/api/memory/${scopeId}/maintenance`, `/api/memory/${scopeId}/facts/not-yet-saved`];
    for (const path of paths) {
      const pending = await fetch(`${origin}${path}`, { headers });
      expect(pending.status).toBe(503);
      expect(pending.headers.get('retry-after')).toBe('1');
      expect(pending.headers.get('cache-control')).toBe('no-store');
      expect(await pending.json()).toEqual({ status: 'unavailable',
        reason: 'permissions_applying' });
    }
    await applyOwnership();
    const available = await fetch(`${origin}/api/memory/scopes`, { headers });
    expect(available.status).toBe(200);
    expect(await available.json()).toMatchObject({ scopes: [
      { scopeKind: 'person', ownerId: 'bootstrap-owner', canRead: true, canWrite: true },
    ] });
    const facts = await fetch(`${origin}/api/memory/${scopeId}/facts`, { headers });
    expect(facts.status).toBe(200);
    expect(await facts.json()).toMatchObject({ facts: [], returnedCount: 0 });
  }, 60_000);

type MemoryFixture = Awaited<ReturnType<typeof setup>>;
type FixtureEvent = Omit<Parameters<typeof appendEvent>[1], 'silo'>;

async function saveFixtureEvent(fixture: MemoryFixture, fields: FixtureEvent) {
  const row = await appendEvent(nats.store, { ...fields, silo: 'acme' });
  await fixture.auth.handler.handle(row.event, fixture.db);
  return row.event;
}

async function addOtherMember(fixture: MemoryFixture) {
  const memberId = 'bob';
  const data = { memberId, role: 'member', email: 'bob@example.test', displayName: 'Bob',
    invitationId: 'bob-invitation', identity: { issuer: fixture.env.OIDC_ISSUER_URL, sub: memberId },
    personalAssistant: 'none' };
  const principal = { kind: 'human' as const, id: memberId };
  await saveFixtureEvent(fixture, { subject: 'member-bob', type: 'member.joined', data, principal });
  await fixture.runner.run(members);
  const config = loadAuthConfig(fixture.env);
  const now = Math.floor(Date.now() / 1000);
  const session = { sub: memberId, orgId: 'org-acme', roles: [], authTime: now, exp: now + 300 };
  const cookie = encodeSession(config, session);
  return { ...fixture.headers, cookie: `${config.cookieName}=${cookie}` };
}

async function addGroupAndSource(fixture: MemoryFixture) {
  const teamId = 'sales';
  const createdBy = 'bootstrap-owner';
  const team = { teamId, name: 'Sales', createdBy };
  await saveFixtureEvent(fixture, { subject: 'team-sales', type: 'team.created', data: team });
  const added = { teamId, memberId: 'bob', addedBy: createdBy };
  await saveFixtureEvent(fixture, { subject: 'team-sales', type: 'team.member_added', data: added });
  const conversationId = 'shared-source';
  const subject = `conversation-${conversationId}`;
  const data = { conversationId, mode: 'direct', createdBy: 'bob',
    participantIds: ['bob', createdBy] };
  await saveFixtureEvent(fixture, { subject, type: 'conversation.created', data });
  const message = { conversationId, authorId: 'bob', authorKind: 'human',
    utterance: 'Synthetic source for Memory', contentType: 'text' };
  const principal = { kind: 'human' as const, id: 'bob' };
  const posted = await appendEvent(nats.store, { silo: 'acme', subject, type: 'message.posted',
    data: message, principal });
  for (const projection of [groups, computers, conversations]) {
    await fixture.runner.run(projection);
  }
  return { conversationId, messageId: posted.event.id };
}

function memoryFacts(origin: string, kind: 'person' | 'group' | 'assistant_notes', id: string) {
  return `${origin}/api/memory/${memoryScopeId('acme', kind, id)}/facts`;
}

function postFact(path: string, headers: HeadersInit, commandId: string,
  sources: { conversationId: string; messageId: string }[] = []) {
  const input = { commandId, text: 'I prefer jasmine tea', kind: 'fact',
    pinned: false, expiresAt: null, sources, dependsOn: [] };
  return fetch(path, { method: 'POST', headers, body: JSON.stringify(input) });
}

async function checksGroupAndForeignMemoryAcrossSchemas() {
  const fixture = await setup(true, true);
  const { origin } = fixture;
  const bob = await addOtherMember(fixture);
  const source = await addGroupAndSource(fixture);
  const shared = memoryFacts(origin, 'group', 'sales');
  const privateFacts = memoryFacts(origin, 'person', 'bootstrap-owner');
  expect((await fetch(privateFacts, { headers: bob })).status).toBe(404);
  expect((await postFact(privateFacts, bob, 'foreign-write')).status).toBe(404);
  expect((await fetch(shared, { headers: fixture.headers })).status).toBe(404);
  expect((await postFact(shared, fixture.headers, 'foreign-group-write')).status).toBe(404);
  expect((await postFact(shared, bob, 'group-fact')).status).toBe(200);
  const personal = memoryFacts(origin, 'person', 'bob');
  const missing = { ...source, messageId: 'missing-message' };
  expect((await postFact(personal, bob, 'missing-source', [missing])).status).toBe(404);
  expect((await postFact(personal, bob, 'personal-fact', [source])).status).toBe(200);
  // Simulate a stale read table that points at a different saved message.
  await fixture.db.query('UPDATE conversation_feed SET event_id=$1 WHERE event_id=$2',
    [missing.messageId, source.messageId]);
  expect((await postFact(personal, bob, 'wrong-source', [missing])).status).toBe(404);
  await until(isolatedMemoryIsCurrent);
  const recalled = await fetch(shared, { headers: bob });
  expect(recalled.status).toBe(200);
  expect(await recalled.json()).toMatchObject({ facts: [{ text: 'I prefer jasmine tea' }] });
}
it('checks private, group and source access with packaged database roles',
  checksGroupAndForeignMemoryAcrossSchemas, 60_000);

async function checksNotesPermissionsAcrossSchemas() {
  const fixture = await setup(true, true);
  const { origin, headers, assistant } = fixture;
  await fixture.auth.handler.handle(assistant, fixture.db);
  const path = memoryFacts(origin, 'assistant_notes', 'personal');
  const scopeId = memoryScopeId('acme', 'assistant_notes', 'personal');
  const bob = await addOtherMember(fixture);
  await addGroupAndSource(fixture);
  expect((await fetch(path, { headers })).status).toBe(404);
  expect((await postFact(path, headers, 'no-write-grant')).status).toBe(404);
  const scopeGrant = { resourceType: 'memory_write', resourceId: scopeId, granteeKind: 'member',
    granteeId: 'bootstrap-owner' };
  const writeSubject = grantStream('memory_write', scopeId);
  const allowWrite = { ...scopeGrant, grantedBy: 'bootstrap-owner' };
  await saveFixtureEvent(fixture, { subject: writeSubject, type: 'grant.given', data: allowWrite });
  expect((await fetch(path, { headers })).status).toBe(404);
  expect((await postFact(path, headers, 'notes-write')).status).toBe(200);
  const revokeWrite = { ...scopeGrant, revokedBy: 'bootstrap-owner' };
  await saveFixtureEvent(fixture, { subject: writeSubject, type: 'grant.revoked', data: revokeWrite });
  for (const granteeId of ['bootstrap-owner', 'bob']) {
    const data = { resourceType: 'memory_read', resourceId: scopeId, granteeKind: 'member',
      granteeId, grantedBy: 'bootstrap-owner' };
    await saveFixtureEvent(fixture, { subject: grantStream('memory_read', scopeId),
      type: 'grant.given', data });
  }
  await until(isolatedMemoryIsCurrent);
  expect((await fetch(path, { headers })).status).toBe(200);
  expect((await postFact(path, headers, 'read-only-grant')).status).toBe(404);
  // Make the permission service report access so this checks the saved assistant owner.
  const client = new TupleClient(fixture.binding);
  const delegated = { user: objectId('person', 'acme', 'bob'), relation: 'acts_for',
    object: objectId('assistant', 'acme', 'personal') };
  await client.write([delegated], []);
  expect((await fixture.auth.actsFor('bob', 'personal')).allowed).toBe(true);
  expect((await fetch(path, { headers: bob })).status).toBe(404);
}
it('requires the personal assistant owner and independent note grants with packaged database roles',
  checksNotesPermissionsAcrossSchemas, 60_000);
