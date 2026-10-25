import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { event, natsFixture } from '@opencrane/event-store/testing';
import type { EventEnvelope, MemoryIdentity } from '@opencrane/events';
import { memoryKeys, memoryScopeId, readMemoryFactIds } from '../src/index.ts';
import { collectEventBackup } from '../../../infra/package/event-backup.ts';
import { restoreEventBackup } from '../../../infra/package/event-restore.ts';
import { database } from './database.ts';

const execute = promisify(execFile);
const refused = 'Memory restore refused; keep target isolated\n';
let directory: string;
let source: Awaited<ReturnType<typeof natsFixture>>;
let frozen: Awaited<ReturnType<typeof natsFixture>>;
let target: Awaited<ReturnType<typeof natsFixture>>;
let storage: Awaited<ReturnType<typeof database>>;
let sourceDirectory: string;
let candidate: string;
let env: NodeJS.ProcessEnv;
let root: MemoryIdentity;
let child: MemoryIdentity;
let survivor: MemoryIdentity;
const references = new Map<string, string>();

function value(memoryId: string, ownerId = 'alice', revision = 1,
  dependsOn: { scopeId: string; memoryId: string; revision: number }[] = []): EventEnvelope {
  const scopeId = memoryScopeId('test', 'person', ownerId);
  const identity: MemoryIdentity = {
    silo: 'test', scopeId, scopeKind: 'person', ownerId, memoryId, revision,
  };
  const keys = memoryKeys(sourceDirectory);
  const reference = keys.provision(identity);
  references.set(`${memoryId}-${revision}`, reference.slice(4));
  const encrypted = keys.encrypt(identity, `Synthetic ${memoryId} canary`);
  const data = { schemaVersion: 1, scopeId, scopeKind: 'person', ownerId, memoryId,
    revision, kind: 'fact', pinned: false, expiresAt: null,
    sources: [{ memberId: ownerId, commandId: memoryId }], dependsOn, ...encrypted };
  const envelope = { ...event(`${memoryId}-${revision}`), subject: `scope-${scopeId}`,
    type: 'memory.written', data };
  if (revision === 1) return envelope;
  return { ...envelope, type: 'memory.corrected',
    data: { ...data, expectedRevision: revision - 1,
      supersedes: { memoryId, revision: revision - 1 }, reason: 'human' } };
}

async function prepare() {
  directory = await mkdtemp(resolve('.tools/memory-recovery-'));
  sourceDirectory = `${directory}/current`;
  candidate = `${directory}/candidate`;
  await mkdir(sourceDirectory, { mode: 0o700 });
  source = await natsFixture();
  frozen = await natsFixture({ provision: false });
  target = await natsFixture({ provision: false });
  storage = await database('pg');
  const scopeId = memoryScopeId('test', 'person', 'alice');
  root = { silo: 'test', scopeId, scopeKind: 'person', ownerId: 'alice',
    memoryId: 'root', revision: 1 };
  child = { ...root, memoryId: 'child' };
  survivor = { ...root, ownerId: 'bob', memoryId: 'neighbour',
    scopeId: memoryScopeId('test', 'person', 'bob') };
  const dependency = [{ scopeId, memoryId: 'root', revision: 1 }];
  await source.seed([value('neighbour', 'bob'), value('root'),
    value('child', 'alice', 1, dependency), value('child', 'alice', 2)]);
  await cp(sourceDirectory, `${directory}/stale`, { recursive: true });
  const backup = `${directory}/backup`;
  await collectEventBackup(source.connection,
    { silo: 'test', attempt: 'original', destination: backup });
  await restoreEventBackup(source.connection, frozen.connection,
    { silo: 'test', directory: backup, disposable: true });
  const older = `${directory}/older`;
  await collectEventBackup(frozen.connection,
    { silo: 'test', attempt: 'frozen', destination: older });
  const { silo: _silo, ...fields } = root;
  const data = { schemaVersion: 1, ...fields, expectedRevision: 1, revision: 2 };
  await source.seed([{ ...event('forget-root'), type: 'memory.forgotten',
    subject: `scope-${scopeId}`, data }]);
  const keys = memoryKeys(sourceDirectory);
  for (const identity of [root, child, { ...child, revision: 2 },
    { ...root, revision: 2 }, { ...child, revision: 3 }]) {
    const reference = keys.provision(identity);
    references.set(`${identity.memoryId}-${identity.revision}`, reference.slice(4));
    keys.delete(identity);
  }
  // Use the frozen source only for byte restoration, never as current deletion evidence.
  await restoreEventBackup(frozen.connection, target.connection,
    { silo: 'test', directory: older, disposable: true });
  const current = await storage.db.query<{ name: string }>('SELECT current_database() AS name');
  const url = new URL(process.env['PG_TEST_URL']!);
  url.pathname = `/${current.rows[0]!.name}`;
  env = { ...process.env, ...target.env('projection'), DATABASE_URL: url.href,
    MEMORY_KEY_DIRECTORY: candidate, SOURCE_MEMORY_KEY_DIRECTORY: sourceDirectory,
    NODE_NO_WARNINGS: '1', LOG_LEVEL: 'silent' };
  for (const [name, setting] of Object.entries(source.env('projection'))) {
    env[`SOURCE_${name}`] = setting;
  }
  await writeGuard();
}

async function writeGuard() {
  const guard = `import { mock } from 'node:test';
import { EventStore } from '@opencrane/event-store';
import * as eventStore from '@opencrane/event-store';
import { writeFileSync } from 'node:fs';
import { HandlerRuntime } from '@opencrane/handlers';
import { SandboxClient } from '../../apps/ops/src/kubernetes.ts';
import * as auth from '@opencrane/auth';
import * as projections from '@opencrane/projections';
let effects = 0;
let injected = 0;
function forbidden() { effects++; throw new Error('Forbidden recovery effect'); }
mock.method(EventStore.prototype, 'append', forbidden);
mock.method(HandlerRuntime.prototype, 'start', forbidden);
mock.method(SandboxClient.prototype, 'mode', forbidden);
mock.method(SandboxClient.prototype, 'credentials', forbidden);
mock.method(globalThis, 'fetch', forbidden);
mock.module('@opencrane/auth', { namedExports: { ...auth, tokenIssuer: forbidden } });
function guardedKeys(path) {
  const keys = projections.memoryKeys(path);
  function status(identity) {
    const result = keys.status(identity);
    const changedDirectory = process.env.CHANGE_INVENTORY;
    if (changedDirectory) {
      writeFileSync(changedDirectory + '/' + 'f'.repeat(64), Buffer.alloc(0), { mode: 0o600 });
      injected++;
    }
    return result;
  }
  const guarded = { ...keys, status, provision: forbidden, delete: forbidden,
    discardUnpublished: forbidden, encrypt: forbidden };
  if (process.env.EXPECT_NO_DECRYPT) guarded.decrypt = forbidden;
  return guarded;
}
async function guardedConnection(settings) {
  const connection = await eventStore.connectNats(settings);
  const request = connection.request.bind(connection);
  let infoReads = 0;
  async function checkedRequest(subject, ...args) {
    const reply = await request(subject, ...args);
    if (process.env.CHANGE_IDENTITY && subject === '$JS.API.STREAM.MSG.GET.EVENTS') {
      const saved = reply.json();
      if (saved.message.seq === 2) {
        const event = JSON.parse(Buffer.from(saved.message.data, 'base64').toString('utf8'));
        event.data.keyId = 'key:' + 'f'.repeat(64);
        saved.message.data = Buffer.from(JSON.stringify(event)).toString('base64');
        injected++;
        function json() { return saved; }
        return { data: reply.data, json };
      }
    }
    if (subject !== '$JS.API.STREAM.INFO.EVENTS') return reply;
    infoReads++;
    const side = settings ? 'source' : 'target';
    if (process.env.CHANGE_HISTORY !== side || infoReads !== 2) return reply;
    const changed = { ...reply.json(), created: '2000-01-01T00:00:00.000Z' };
    injected++;
    function json() { return changed; }
    return { data: reply.data, json };
  }
  mock.method(connection, 'request', checkedRequest);
  return connection;
}
const eventStoreExports = { ...eventStore, connectNats: guardedConnection };
mock.module('@opencrane/event-store', { namedExports: eventStoreExports });
const namedExports = { ...projections, memoryKeys: guardedKeys };
if (process.env.EXPECT_REFUSAL) namedExports.connectProjectionDb = forbidden;
mock.module('@opencrane/projections', { namedExports });
process.on('exit', function report() {
  if ((process.env.CHANGE_HISTORY || process.env.CHANGE_INVENTORY || process.env.CHANGE_IDENTITY)
      && injected === 0) effects++;
  if (process.env.CHANGE_IDENTITY && injected !== 2) effects++;
  process.stdout.write('effects:' + effects + '\\n');
});
`;
  await writeFile(`${directory}/guard.mjs`, guard);
}
beforeAll(prepare);
afterAll(async function cleanup() {
  if (storage) await storage.close();
  for (const fixture of [source, frozen, target]) {
    if (fixture) await fixture.close();
  }
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function resetCandidate(from = sourceDirectory) {
  await rm(candidate, { recursive: true, force: true });
  await cp(from, candidate, { recursive: true });
}
function run(settings = env, flag = '--confirm-stopped', silo = 'test') {
  const args = ['--experimental-strip-types', '--experimental-test-module-mocks',
    '--import', `${directory}/guard.mjs`, 'infra/package/memory-restore-check-run.ts',
    silo, flag];
  return execute(process.execPath, args, { env: settings, timeout: 15_000 });
}
const faults = ['stale', 'missing-marker', 'missing-survivor', 'wrong-key', 'damaged',
  'historical-child', 'source-missing', 'source-incomplete', 'unconfirmed', 'source-unreachable',
  'wrong-silo', 'pending-deletion', 'historical-unverified'] as const;
it.each(faults)('refuses %s before opening the projection database', async function refusal(fault) {
  await resetCandidate(fault === 'stale' ? `${directory}/stale` : sourceDirectory);
  const settings: NodeJS.ProcessEnv = { ...env, EXPECT_REFUSAL: '1' };
  const rootPath = `${candidate}/${references.get('root-1')!}`;
  const survivorPath = `${candidate}/${references.get('neighbour-1')!}`;
  if (fault === 'missing-marker') await rm(rootPath);
  if (fault === 'missing-survivor') await rm(survivorPath);
  if (fault === 'damaged') await writeFile(survivorPath, Buffer.alloc(31));
  if (fault === 'wrong-key') await writeFile(survivorPath, Buffer.alloc(32, 7));
  if (fault === 'historical-child') {
    const name = references.get('child-1')!;
    await cp(`${directory}/stale/${name}`, `${candidate}/${name}`);
  }
  if (fault === 'source-missing') settings['SOURCE_MEMORY_KEY_DIRECTORY'] = `${directory}/absent`;
  if (fault === 'source-incomplete') {
    await cp(sourceDirectory, `${directory}/incomplete`, { recursive: true });
    await rm(`${directory}/incomplete/${references.get('root-1')!}`);
    settings['SOURCE_MEMORY_KEY_DIRECTORY'] = `${directory}/incomplete`;
    await rm(rootPath);
  }
  if (fault === 'source-unreachable') {
    settings['SOURCE_NATS_URL'] = 'nats://127.0.0.1:1';
  }
  if (fault === 'pending-deletion') {
    await resetCandidate(`${directory}/stale`);
    settings['SOURCE_MEMORY_KEY_DIRECTORY'] = `${directory}/stale`;
  }
  await historicalEvidence(fault, settings);
  const silo = fault === 'wrong-silo' ? 'foreign' : 'test';
  const flag = fault === 'unconfirmed' ? '--unknown' : '--confirm-stopped';
  await expect(run(settings, flag, silo)).rejects.toMatchObject({ stdout: 'effects:0\n', stderr: refused });
  const tables = await storage.db.query("SELECT tablename FROM pg_tables WHERE schemaname='public'");
  expect(tables.rows).toEqual([]);
});

async function historicalEvidence(fault: string, settings: NodeJS.ProcessEnv) {
  if (fault !== 'historical-unverified') return;
  const incomplete = `${directory}/historical`;
  await cp(sourceDirectory, incomplete, { recursive: true });
  const name = references.get('child-2')!;
  await cp(`${directory}/stale/${name}`, `${incomplete}/${name}`);
  await resetCandidate(incomplete);
  settings['SOURCE_MEMORY_KEY_DIRECTORY'] = incomplete;
}

const matchingDamage = ['empty', 'missing', 'wrong-key'] as const;
async function damagedSurvivor(fault: typeof matchingDamage[number]) {
  const damagedSource = `${directory}/survivor-${fault}`;
  await cp(sourceDirectory, damagedSource, { recursive: true });
  const path = `${damagedSource}/${references.get('neighbour-1')!}`;
  if (fault === 'missing') {
    await rm(path);
  } else if (fault === 'empty') {
    await writeFile(path, Buffer.alloc(0));
  } else {
    await writeFile(path, Buffer.alloc(32, 7));
  }
  await resetCandidate(damagedSource);
  const settings = { ...env, SOURCE_MEMORY_KEY_DIRECTORY: damagedSource, EXPECT_REFUSAL: '1' };
  await expect(run(settings)).rejects.toMatchObject({
    stdout: 'effects:0\n', stderr: refused,
  });
  const tables = await storage.db.query("SELECT tablename FROM pg_tables WHERE schemaname='public'");
  expect(tables.rows).toEqual([]);
}
it.each(matchingDamage)('refuses matching %s surviving custody in both folders', damagedSurvivor);

const lateRefusals = ['root-1', 'root-2', 'child-3', 'key-identity', 'source-history', 'target-history',
  'source-inventory', 'candidate-inventory'] as const;
async function refuseBeforeDecryption(fault: typeof lateRefusals[number]) {
  const changedSource = `${directory}/late-${fault}`;
  await cp(sourceDirectory, changedSource, { recursive: true });
  const settings: NodeJS.ProcessEnv = { ...env, SOURCE_MEMORY_KEY_DIRECTORY: changedSource,
    EXPECT_REFUSAL: '1', EXPECT_NO_DECRYPT: '1' };
  if (fault === 'key-identity') {
    settings['CHANGE_IDENTITY'] = '1';
  } else if (fault === 'source-history') {
    settings['CHANGE_HISTORY'] = 'source';
  } else if (fault === 'target-history') {
    settings['CHANGE_HISTORY'] = 'target';
  } else if (fault === 'source-inventory') {
    settings['CHANGE_INVENTORY'] = changedSource;
  } else if (fault === 'candidate-inventory') {
    settings['CHANGE_INVENTORY'] = candidate;
  } else {
    await rm(`${changedSource}/${references.get(fault)!}`);
  }
  await resetCandidate(changedSource);
  await expect(run(settings)).rejects.toMatchObject({
    stdout: 'effects:0\n', stderr: refused,
  });
  const tables = await storage.db.query("SELECT tablename FROM pg_tables WHERE schemaname='public'");
  expect(tables.rows).toEqual([]);
}
it.each(lateRefusals)('refuses %s before decrypting an earlier surviving fact', refuseBeforeDecryption);

async function snapshot() {
  const facts = await storage.db.query('SELECT * FROM memory_facts ORDER BY scope_id, memory_id');
  const receipts = await storage.db.query('SELECT * FROM projection_events ORDER BY event_id');
  const checkpoints = await storage.db.query('SELECT * FROM projection_checkpoints');
  const markers: Record<string, string> = {};
  for (const name of await readdir(candidate)) {
    const bytes = await readFile(`${candidate}/${name}`);
    markers[name] = bytes.toString('hex');
  }
  return { facts: facts.rows, receipts: receipts.rows, checkpoints: checkpoints.rows, markers };
}
it('replays older events twice with current markers, scoped search and zero effects',
  async function recovery() {
    await resetCandidate();
    const first = await run();
    expect(first.stdout).toContain('PASS: memory rebuilt through event 4');
    expect(first.stdout).toContain('effects:0');
    expect(first.stderr).toBe('');
    const before = await snapshot();
    const second = await run();
    expect(second.stdout).toContain('effects:0');
    expect(second.stderr).toBe('');
    expect(await snapshot()).toEqual(before);
    expect(await readMemoryFactIds(storage.db, 'test', root.scopeId, 'canary')).toEqual([]);
    expect(await readMemoryFactIds(storage.db, 'test', survivor.scopeId, 'canary'))
      .toEqual([{ memory_id: 'neighbour' }]);
    const erased = await storage.db.query(`SELECT search_text, search_vector FROM memory_facts
      WHERE owner_id='alice'`);
    expect(erased.rows).toEqual([
      { search_text: null, search_vector: null }, { search_text: null, search_vector: null },
    ]);
    const jobs = await storage.db.query("SELECT tablename FROM pg_tables WHERE schemaname='pgboss'");
    expect(jobs.rows).toEqual([]);
    expect(await source.reader.head()).toBe(5);
    expect(await target.reader.head()).toBe(4);
    const output = first.stdout + first.stderr + second.stdout + second.stderr;
    expect(output).not.toContain('canary');
    for (const identity of [root, child, { ...child, revision: 2 }]) {
      expect(memoryKeys(candidate).status(identity)).toBe('destroyed');
    }
  });

it('refuses truncated current source history before opening the database', async function gap() {
  await resetCandidate();
  const before = await snapshot();
  const info = await source.connection.request('$JS.API.STREAM.INFO.EVENTS', '{}');
  const saved = info.json<{ config: Record<string, unknown> }>();
  const config = { ...saved.config, max_msgs: 4 };
  const changed = await source.connection.request('$JS.API.STREAM.UPDATE.EVENTS',
    JSON.stringify(config));
  expect(changed.json()).toMatchObject({ state: { first_seq: 2, messages: 4 } });
  const settings: NodeJS.ProcessEnv = { ...env, EXPECT_REFUSAL: '1' };
  await expect(run(settings)).rejects.toMatchObject({ stdout: 'effects:0\n', stderr: refused });
  expect(await snapshot()).toEqual(before);
});
