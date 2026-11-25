import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import { event, natsFixture } from '@opencrane/event-store/testing';
import { budgets } from '@opencrane/models';
import { members, mcpCatalogue, computers, conversations, files, auditTrail,
  personalSettings, groups, providers, modelAccess, egressPolicy, connectionProfiles,
  childRequests, routines } from '@opencrane/projections';
import { packageBackupSource } from './scheduled-backup-source.ts';
import { captureScheduledBackup, listBackups } from './scheduled-backup.ts';

const storage = vi.hoisted(function storageState() {
  return new Map<string, Buffer>();
});
vi.mock('./pilot-storage.ts', function objectStoreBoundary() {
  async function* listObjectsV2() {
    for (const name of storage.keys()) yield { name };
  }
  async function getObject(_bucket: string, key: string) {
    return Readable.from([storage.get(key)!]);
  }
  async function pilotStorage() {
    return { listObjectsV2, getObject };
  }
  return { pilotStorage };
});

const database = vi.hoisted(function databaseState() {
  return { behind: '', clients: '0', names: [] as string[],
    deferDisconnect: false, pendingDisconnects: 0, fileReferences: [] as unknown[] };
});
vi.mock('pg', function databaseBoundary() {
  class Client {
    protected readCheckpoints = false;

    connect() { return Promise.resolve(); }

    query(sql: string) {
      if (sql.includes('conversation_files')) {
        function asRow(data: unknown) { return { data }; }
        return { rows: database.fileReferences.map(asRow) };
      }
      if (sql.includes('pg_stat_activity')) {
        const count = Number(database.clients) + database.pendingDisconnects;
        return { rows: [{ count: String(count) }] };
      }
      if (sql.includes('pg_current_wal_lsn')) return { rows: [{ lsn: '0/123' }] };
      if (sql.includes('projection_checkpoints')) {
        this.readCheckpoints = true;
        const rows = [];
        for (const name of database.names) {
          const sequence = database.behind === name ? '0' : '1';
          rows.push({ name, sequence });
        }
        return { rows };
      }
      if (sql.includes('handler_dispatcher')) {
        this.readCheckpoints = true;
        return { rows: [{ sequence: '1' }] };
      }
      throw new Error('Unexpected database query');
    }
    end() { return Promise.resolve(); }
  }
  class Pool extends Client {
    override end() {
      // Let pool shutdown finish before PostgreSQL sees the reader disconnect.
      if (this.readCheckpoints && database.deferDisconnect) {
        database.pendingDisconnects += 1;
      }
      return super.end();
    }
  }
  return { Client, Pool };
});
vi.mock('node:timers/promises', async function pollingClock(importOriginal) {
  const actual = await importOriginal<typeof import('node:timers/promises')>();
  function expireWait() {
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 240_001);
    return Promise.resolve();
  }
  return { ...actual, setTimeout: expireWait };
});
const projectionNames = [members.name, mcpCatalogue.name, computers.name, conversations.name,
  files.name, budgets.name, auditTrail.name, personalSettings.name, groups.name, providers.name,
  modelAccess.name, egressPolicy.name, connectionProfiles.name, childRequests.name];
const services = ['server', 'worker-dispatcher', 'worker-members', 'worker-mcp-catalogue',
  'worker-computers', 'worker-conversations', 'worker-files', 'worker-budgets', 'worker-audit',
  'openfga'];

afterEach(function reset() {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  database.behind = '';
  database.clients = '0';
  database.deferDisconnect = false;
  database.pendingDisconnects = 0;
  database.fileReferences = [];
  storage.clear();
});

async function fixture(ready = true, providerMode = false, captureFiles = false) {
  database.names = projectionNames;
  const directory = await mkdtemp(join(tmpdir(), 'backup-adapter-'));
  const nats = await natsFixture();
  await nats.seed([event('backup-event')]);
  const calls = join(directory, 'calls');
  const command = join(directory, 'kubectl');
  const script = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.BACKUP_TEST_CALLS, args.join(' ') + '\\n');
if (args[0] === 'rollout' && process.env.BACKUP_TEST_READY === 'no') process.exit(1);
`;
  await writeFile(command, script);
  await chmod(command, 0o700);
  for (const [name, value] of Object.entries(nats.env())) vi.stubEnv(name, value);
  vi.stubEnv('PATH', `${directory}:${process.env['PATH']}`);
  vi.stubEnv('BACKUP_TEST_CALLS', calls);
  vi.stubEnv('BACKUP_TEST_READY', ready ? 'yes' : 'no');
  const backupDirectory = join(directory, 'sets');
  await mkdir(backupDirectory, { mode: 0o700 });
  const options = { directory: backupDirectory, id: 'adapter-backup',
    silo: 'test', images: { server: 'test' }, providerMode };
  const runtime = await packageBackupSource(options);
  const replicas = new Map<string, number>();
  function kube(args: string[]) {
    if (args[0] === 'scale') {
      replicas.set(args[1]!.replace('deployment/', ''), 0);
      return Promise.resolve('');
    }
    if (args[1] === 'pods') return Promise.resolve(JSON.stringify({ items: [] }));
    if (args[4] === 'json') return Promise.resolve(JSON.stringify({ spec: { replicas: 1 } }));
    return Promise.resolve(String(replicas.get(args[2]!)));
  }
  async function databasePart(destination: string) {
    await writeFile(destination, 'fixture database', { mode: 0o600 });
    return { databases: ['postgres'], lsn: '0/123',
      access: { storeId: 'saved-store', modelId: 'saved-model' } };
  }
  async function filesPart(destination: string) {
    await writeFile(destination, 'fixture files', { mode: 0o600 });
    return { bucket: 'files', objects: [] };
  }
  vi.spyOn(runtime.source, 'kube').mockImplementation(kube);
  runtime.source.parts.database = databasePart;
  if (!captureFiles) runtime.source.parts.files = filesPart;
  async function close() {
    await runtime.close();
    await nats.close();
    await rm(directory, { recursive: true, force: true });
  }
  onTestFinished(close);
  return { directory: backupDirectory, options, source: runtime.source, calls, kube, nats };
}

const upload = {
  conversationId: 'conv_1', fileId: 'file_1', uploadedBy: 'mem_1', name: 'notes.txt',
  size: 3, sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  mime: 'text/plain', objectKey: 'test/conv_1/file_1',
};

for (const mismatch of ['object without event', 'event without object', 'wrong object bytes']) {
  it(`refuses publication with ${mismatch}`, async function refusesFilesMismatch() {
    const test = await fixture(true, false, true);
    if (mismatch !== 'object without event') database.fileReferences.push(upload);
    if (mismatch === 'object without event') storage.set(upload.objectKey, Buffer.from('abc'));
    if (mismatch === 'wrong object bytes') storage.set(upload.objectKey, Buffer.from('abd'));
    await expect(captureScheduledBackup(test.options, test.source)).rejects.toMatchObject({
      cause: { kind: 'scheduled_backup', reason: 'parts' },
    });
    expect(await listBackups(test.directory)).toEqual([]);
    expect(await readdir(test.directory)).toEqual([]);
    const calls = await readFile(test.calls, 'utf8');
    expect(calls).toContain('scale deployment/server --replicas=1');
  });
}

it('captures through the real pause, verify, event and restart adapter', async function valid() {
  const test = await fixture();
  await captureScheduledBackup(test.options, test.source);
  expect(await listBackups(test.directory)).toHaveLength(1);
  const calls = await readFile(test.calls, 'utf8');
  for (const name of services) {
    expect(calls).toContain(`scale deployment/${name} --replicas=1`);
    expect(calls).toContain(`rollout status deployment/${name} --timeout=60s`);
  }
});

it('publishes a checked set even when a pool would leave its checkpoint readers connected',
  async function closesCheckpointReaders() {
    const test = await fixture();
    const filesPart = test.source.parts.files;
    async function captureFiles(destination: string) {
      const details = await filesPart(destination);
      database.deferDisconnect = true;
      return details;
    }
    test.source.parts.files = captureFiles;
    const manifest = await captureScheduledBackup(test.options, test.source);
    expect(await listBackups(test.directory)).toEqual([manifest]);
  });

for (const brokenPart of [false, true]) {
  it(`retains maintenance after accepted scales with unavailable replacements (part=${brokenPart})`,
    async function unavailableReplacements() {
      const test = await fixture(false);
      function failPart() { return Promise.reject(new Error('broken part')); }
      if (brokenPart) test.source.parts.files = failPart;
      await expect(captureScheduledBackup(test.options, test.source))
        .rejects.toThrow('Maintenance remains active; services could not restart');
      expect(await listBackups(test.directory)).toEqual([]);
      expect(await readFile(join(test.directory, '.lock'), 'utf8')).toContain('adapter-backup');
      const calls = await readFile(test.calls, 'utf8');
      for (const name of services) {
        expect(calls).toContain(`scale deployment/${name} --replicas=1`);
        expect(calls).toContain(`rollout status deployment/${name} --timeout=60s`);
      }
    });
}

const violations = ['replicas', 'pods', 'deployment', 'created', 'first_seq', 'last_seq',
  'messages', 'clients', 'descriptor', ...projectionNames] as const;
for (const violation of violations) {
  it(`refuses an otherwise valid capture with ${violation} changed and recovers`,
    async function refusesViolation() {
      const test = await fixture();
      const originalInfo = test.source.eventInfo.bind(test.source);
      let infoReads = 0;
      async function eventInfo() {
        const info = await originalInfo();
        infoReads += 1;
        if (infoReads === 1) return info;
        if (violation === 'created') info.created = '2020-01-01T00:00:00Z';
        if (violation === 'first_seq') info.state.first_seq += 1;
        if (violation === 'last_seq') info.state.last_seq += 1;
        if (violation === 'messages') info.state.messages += 1;
        return info;
      }
      async function kube(args: string[]) {
        if (violation === 'replicas' && args[2] === 'worker-dispatcher' && args[4] === 'json') {
          return JSON.stringify({ spec: { replicas: 2 } });
        }
        if (violation === 'pods' && args[1] === 'pods') return '{"items":[{}]}';
        if (violation === 'deployment' && args[4]?.startsWith('jsonpath=')) return '1';
        return test.kube(args);
      }
      if (projectionNames.includes(violation)) database.behind = violation;
      if (violation === 'clients') database.clients = '1';
      const kubeProbe = vi.spyOn(test.source, 'kube').mockImplementation(kube);
      vi.spyOn(test.source, 'eventInfo').mockImplementation(eventInfo);
      if (violation === 'descriptor') {
        const capture = test.source.parts.events;
        async function movedDescriptor(destination: string) {
          await test.nats.seed([event('later-event')]);
          return capture(destination);
        }
        test.source.parts.events = movedDescriptor;
      }
      const capture = captureScheduledBackup(test.options, test.source);
      let stage = 'pause';
      if (violation === 'descriptor') stage = 'parts';
      await expect(capture).rejects.toMatchObject({
        message: 'Scheduled backup failed',
        cause: { kind: 'scheduled_backup', reason: stage },
      });
      if (projectionNames.includes(violation)) {
        expect(kubeProbe.mock.calls).not.toContainEqual(
          [['scale', 'deployment/worker-members', '--replicas=0', '--current-replicas=1']]);
      }
      expect(await listBackups(test.directory)).toEqual([]);
      expect(await readdir(test.directory)).not.toContain('.lock');
      const calls = await readFile(test.calls, 'utf8');
      expect(calls).toContain('scale deployment/server --replicas=1');
      expect(calls).toContain('rollout status deployment/server --timeout=60s');
    });
}

async function pausesProviderSelectionProjection() {
  const test = await fixture(true, true);
  database.names = [...projectionNames, routines.name];
  const command = vi.mocked(test.source.kube);
  await test.source.pause();
  expect(command).toHaveBeenCalledWith([
    'scale', 'deployment/worker-routines', '--replicas=0', '--current-replicas=1',
  ]);
  await test.source.resume();
  const calls = await readFile(test.calls, 'utf8');
  expect(calls).toContain('scale deployment/worker-routines --replicas=1');
}
it('provider backups pause and resume the model-selection projection',
  pausesProviderSelectionProjection);

async function refusesLaggingProviderProjection() {
  const test = await fixture(true, true);
  database.names = [...projectionNames, routines.name];
  database.behind = routines.name;
  await expect(test.source.pause()).rejects.toThrow('Backup deadline');
  const command = vi.mocked(test.source.kube);
  expect(command).not.toHaveBeenCalledWith([
    'scale', 'deployment/worker-routines', '--replicas=0', '--current-replicas=1',
  ]);
}
it('provider backups wait for the routines checkpoint before stopping its reader',
  refusesLaggingProviderProjection);
