import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { encodeSession } from '@opencrane/auth';
import { createStore, memberAuthorisation } from '@opencrane/authz';
import { databases, openfga, until } from '@opencrane/authz/testing';
import { event, natsFixture } from '@opencrane/event-store/testing';
import { pgDb } from '@opencrane/projections';
import { buildServer } from '../src/server.ts';
import { testAuthConfig } from './support/test-auth-config.ts';

const config = testAuthConfig({ expectedOrgId: 'org-acme' });
let nats: Awaited<ReturnType<typeof natsFixture>>;
let fga: Awaited<ReturnType<typeof openfga>>;
let storage: Awaited<ReturnType<typeof databases>>;
let directory: string;
let app: ReturnType<typeof buildServer>;
let worker: ChildProcess;
let stopped: Promise<unknown[]>;
let output: string;

beforeEach(async function setup() {
  nats = await natsFixture();
  fga = await openfga();
  storage = await databases();
  directory = await mkdtemp('/tmp/memory-worker-');
  const binding = await createStore(fga.apiUrl, 'acme');
  const joined = { ...event('joined', 'member-bob', 'member.joined'), silo: 'acme',
    data: { memberId: 'bob', role: 'member', email: 'bob@example.test', displayName: 'Bob' } };
  expect((await nats.store.append({ event: joined, expectedSequence: 0 })).status)
    .toBe('appended');
  await memberAuthorisation(binding).handler.handle(joined, pgDb(storage.queue));
  function memberId() {
    return Promise.resolve('bob');
  }
  const memory = { silo: 'acme', store: nats.store, binding, db: pgDb(storage.queue),
    feed: { memberId } };
  app = buildServer(config, { memory });
});

afterEach(async function cleanup() {
  if (worker && worker.exitCode === null && worker.signalCode === null) worker.kill('SIGTERM');
  await stopped;
  await app?.close();
  await storage?.close();
  await fga?.close();
  await nats?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

function startWorker(configureKeys: boolean) {
  const databaseUrl = storage.queue.options.connectionString;
  const env = { ...process.env, ...nats.env('projection'), DATABASE_URL: databaseUrl,
    LOG_LEVEL: 'info' };
  delete env['MEMORY_KEY_DIRECTORY'];
  if (configureKeys) env['MEMORY_KEY_DIRECTORY'] = directory;
  output = '';
  worker = spawn(process.execPath, ['--experimental-strip-types', 'apps/ops/src/worker.ts',
    'memory'], { env });
  function collect(chunk: Buffer) {
    output += chunk.toString();
  }
  worker.stdout?.on('data', collect);
  worker.stderr?.on('data', collect);
  stopped = once(worker, 'exit');
}

function scopes() {
  const session = { sub: 'bob', orgId: 'org-acme', roles: ['member'],
    authTime: 1790856000, exp: 2000000000 };
  const headers = { cookie: `${config.cookieName}=${encodeSession(config, session)}` };
  return app.inject({ method: 'GET', url: '/api/memory/scopes', headers });
}

it('starts an empty live memory projection and serves scopes on a fresh database',
  async function freshMemory() {
    startWorker(true);
    async function ready() {
      if (worker.exitCode !== null || worker.signalCode !== null) {
        throw new Error(`Memory worker stopped: ${output}`);
      }
      const response = await scopes();
      if (response.statusCode !== 200) return false;
      const saved = await storage.queue.query<{ sequence: string }>(
        "SELECT sequence FROM projection_checkpoints WHERE name='memory'");
      return Number(saved.rows[0]?.sequence) === await nats.store.head();
    }
    await until(ready);
    const checkpoint = await storage.queue.query<{ sequence: string }>(
      "SELECT sequence FROM projection_checkpoints WHERE name='memory'");
    expect(Number(checkpoint.rows[0]?.sequence)).toBe(await nats.store.head());
    const facts = await storage.queue.query('SELECT * FROM memory_facts');
    expect(facts.rows).toEqual([]);
    expect((await scopes()).json()).toMatchObject({ scopes: [{ ownerId: 'bob' }] });
    expect(await readdir(directory)).toEqual([]);
    await app.close();
    app = buildServer(config);
    const unavailable = await scopes();
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json()).toEqual({ status: 'unavailable', reason: 'memory_unavailable' });
  });

it('logs once and serves memory_unavailable when key custody is not configured',
  async function missingKeys() {
    startWorker(false);
    await stopped;
    expect(worker.exitCode).toBe(0);
    const messages = output.match(/Memory reads unavailable: MEMORY_KEY_DIRECTORY is not configured/gu);
    expect(messages).toHaveLength(1);
    const response = await scopes();
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'unavailable', reason: 'memory_unavailable' });
  });
