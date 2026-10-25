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
  await source.seed([value('root'), value('child', 'alice', 1, dependency),
    value('child', 'alice', 2), value('neighbour', 'bob')]);
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
    { ...root, revision: 2 }, { ...child, revision: 3 }]) keys.delete(identity);
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
  const guard = `import { mock } from 'node:test';
import '../../apps/ops/test/support/routine-effects.ts';
import * as projections from '@opencrane/projections';
let effects = 0;
function forbidden() { effects++; throw new Error('Forbidden recovery effect'); }
function guardedKeys(path) {
  return { ...projections.memoryKeys(path), provision: forbidden, delete: forbidden,
    discardUnpublished: forbidden, encrypt: forbidden };
}
const namedExports = { ...projections, memoryKeys: guardedKeys };
if (process.env.EXPECT_REFUSAL) namedExports.connectProjectionDb = forbidden;
mock.module('@opencrane/projections', { namedExports });
process.on('exit', function report() { process.stdout.write('effects:' + effects + '\\n'); });
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
function run(settings = env, flag = '--confirm-stopped') {
  const args = ['--experimental-strip-types', '--experimental-test-module-mocks',
    '--import', `${directory}/guard.mjs`, 'infra/package/memory-restore-check-run.ts',
    'test', flag];
  return execute(process.execPath, args, { env: settings, timeout: 15_000 });
}
const faults = ['stale', 'missing-marker', 'missing-survivor', 'wrong-key', 'damaged',
  'historical-child', 'source-missing', 'source-incomplete', 'unconfirmed', 'source-unreachable'] as const;
it.each(faults)('refuses %s before opening the projection database', async function refusal(fault) {
  await resetCandidate(fault === 'stale' ? `${directory}/stale` : sourceDirectory);
  const settings = { ...env, EXPECT_REFUSAL: '1' };
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
  if (fault === 'source-missing') settings.SOURCE_MEMORY_KEY_DIRECTORY = `${directory}/absent`;
  if (fault === 'source-incomplete') {
    await cp(sourceDirectory, `${directory}/incomplete`, { recursive: true });
    await rm(`${directory}/incomplete/${references.get('root-1')!}`);
    settings.SOURCE_MEMORY_KEY_DIRECTORY = `${directory}/incomplete`;
  }
  if (fault === 'source-unreachable') {
    settings.SOURCE_NATS_URL = 'nats://127.0.0.1:1';
  }
  const flag = fault === 'unconfirmed' ? '--unknown' : '--confirm-stopped';
  await expect(run(settings, flag)).rejects.toMatchObject({ stdout: 'effects:0\n', stderr: refused });
  const tables = await storage.db.query("SELECT tablename FROM pg_tables WHERE schemaname='public'");
  expect(tables.rows).toEqual([]);
});

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
