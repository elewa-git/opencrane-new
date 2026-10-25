import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, stat } from 'node:fs/promises';
import { afterEach, expect, it } from 'vitest';
import { encodeSession, loadAuthConfig } from '@opencrane/auth';
import { createStore, grantStream, memberAuthorisation } from '@opencrane/authz';
import { databases, openfga, until } from '@opencrane/authz/testing';
import { event, natsFixture } from '@opencrane/event-store/testing';
import { createLogger } from '@opencrane/observability';
import { seedOwnership } from '@opencrane/models';
import { members, memoryScopeId, pgDb, ProjectionRunner } from '@opencrane/projections';
import { startServer, TEST_OIDC_ENV, type RunningServer } from './support/process.ts';

let nats: Awaited<ReturnType<typeof natsFixture>>;
let storage: Awaited<ReturnType<typeof databases>>;
let fga: Awaited<ReturnType<typeof openfga>>;
let server: RunningServer | undefined;
let directory: string;
let worker: ChildProcess | undefined;
let workerStopped: Promise<unknown[]> | undefined;
let workerOutput = '';

afterEach(async function cleanup() {
  await server?.stop();
  if (worker && worker.exitCode === null && worker.signalCode === null) {
    worker.kill('SIGTERM');
  }
  await workerStopped;
  await storage?.close();
  await fga?.close();
  await nats?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function setup() {
  workerOutput = '';
  nats = await natsFixture();
  storage = await databases();
  fga = await openfga();
  directory = await mkdtemp('/tmp/memory-main-');
  await mkdir(`${directory}/memory-keys`, { mode: 0o700 });
  await mkdir(`${directory}/personal-keys`, { mode: 0o700 });
  const binding = await createStore(fga.apiUrl, 'acme');
  const databaseUrl = storage.queue.options.connectionString;
  const env = {
    ...TEST_OIDC_ENV, ...nats.env(), SILO_ID: 'acme', DATABASE_URL: databaseUrl,
    OIDC_EXPECTED_ORG_ID: 'org-acme', OPENFGA_API_URL: binding.apiUrl,
    OPENFGA_STORE_ID: binding.storeId, OPENFGA_MODEL_ID: binding.authorizationModelId,
    MEMORY_KEY_DIRECTORY: `${directory}/memory-keys`,
    PERSONAL_KEY_DIRECTORY: `${directory}/personal-keys`, CONVERSATION_KEYS_DIR: '',
  };
  const db = pgDb(storage.queue);
  const runner = new ProjectionRunner(db, nats.reader, createLogger('memory-main'));
  await runner.initialise(members);
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
  for await (const row of nats.store.readStream('ownership-acme')) {
    await auth.handler.handle(row.event, db);
  }
  await runner.run(members);
  startMemoryWorker(env);
  await until(memoryReady);
  server = await startServer(env);
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
  return { headers, origin, env, assistant, auth, db };
}

function startMemoryWorker(env: NodeJS.ProcessEnv) {
  const args = ['--experimental-strip-types', 'apps/ops/src/worker.ts', 'memory'];
  const workerEnv = { ...process.env, ...env, ...nats.env('projection'), LOG_LEVEL: 'info' };
  worker = spawn(process.execPath, args, { env: workerEnv });
  function collect(chunk: Buffer) {
    workerOutput += chunk.toString();
  }
  worker.stdout?.on('data', collect);
  worker.stderr?.on('data', collect);
  workerStopped = once(worker, 'exit');
}

async function memoryReady() {
  if (!worker || worker.exitCode !== null || worker.signalCode !== null) {
    throw new Error(`Memory worker stopped: ${workerOutput}`);
  }
  const result = await storage.queue.query<{ sequence: string }>(
    "SELECT sequence FROM projection_checkpoints WHERE name='memory'");
  return Number(result.rows[0]?.sequence) === await nats.store.head();
}

it('loads empty personal memory, saves a fact and recalls it through the dev-stack entrypoint',
  async function firstMemory() {
    const { origin, headers, env } = await setup();
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
    expect({ status: saved.status, body: await saved.json() }).toMatchObject({ status: 200,
      body: { outcome: 'saved', revision: 1 } });
    await until(memoryReady);
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
