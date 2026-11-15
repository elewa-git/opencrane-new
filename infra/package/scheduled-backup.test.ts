import { mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { captureScheduledBackup, listBackups, showBackup } from './scheduled-backup.ts';
import type { BackupPoint } from './scheduled-backup.ts';

const directories: string[] = [];
type MaintenanceHandle = Pick<FileHandle, 'writeFile' | 'sync'>;

function isMaintenanceHandle(value: unknown): value is MaintenanceHandle {
  return value !== null && typeof value === 'object' &&
    'writeFile' in value && typeof value.writeFile === 'function' &&
    'sync' in value && typeof value.sync === 'function';
}

afterEach(async function clean() {
  for (const directory of directories) await rm(directory, { recursive: true, force: true });
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'scheduled-backup-'));
  directories.push(directory);
  let stopped = false;
  let resumed = false;
  const point: BackupPoint = { sequence: 42, lsn: '0/123', checkpoints: { files: 42 } };
  const observations: string[] = [];
  function pause() {
    stopped = true;
    return Promise.resolve(point);
  }
  function verify() {
    expect(stopped).toBe(true);
    observations.push('verify');
    return Promise.resolve(point);
  }
  async function capture(destination: string) {
    expect(stopped).toBe(true);
    const name = destination.split('/').at(-1)!;
    observations.push(name);
    await writeFile(destination, `${name} at sequence 42`);
    return { position: 42 };
  }
  function resume() {
    stopped = false;
    resumed = true;
    return Promise.resolve();
  }
  function wasResumed() { return resumed; }
  const parts = { events: capture, database: capture, files: capture };
  const source = { pause, verify, resume, parts };
  const options = { directory, id: 'backup-one', silo: 'test', images: { server: 'test-image' } };
  return { directory, options, source, observations, point, wasResumed };
}

it('publishes three checked parts from one stopped point and lists exactly those bytes',
  async function capturesTogether() {
    const test = await fixture();
    await captureScheduledBackup(test.options, test.source);
    expect(test.wasResumed()).toBe(true);
    const listed = await listBackups(test.directory);
    expect(listed).toHaveLength(1);
    const manifest = await showBackup(test.directory, 'backup-one');
    expect(listed[0]).toEqual(manifest);
    expect(manifest.point).toEqual(test.point);
    expect(manifest.id).toBe('backup-one');
    expect(Object.keys(manifest.parts)).toEqual(['events', 'database', 'files']);
    for (const part of Object.values(manifest.parts)) {
      expect(part.backupId).toBe(manifest.id);
      expect(part.sequence).toBe(42);
      expect(part.byteCount).toBeGreaterThan(0);
      expect(Number.isSafeInteger(part.byteCount)).toBe(true);
      expect(part.sha256).toMatch(/^[a-f0-9]{64}$/u);
      const bytes = await readFile(join(test.directory, 'backup-one', part.path));
      expect(bytes.length).toBe(part.byteCount);
    }
    expect(test.observations).toEqual(['verify', 'events', 'database', 'files', 'verify']);
  });

for (const part of ['events', 'database', 'files'] as const) {
  it(`fails the whole run visibly when ${part} fails and restores admission`,
    async function refusesFailedPart() {
      const test = await fixture();
      function broken(): Promise<never> {
        return Promise.reject(new Error('private-credential-canary'));
      }
      test.source.parts[part] = broken;
      await expect(captureScheduledBackup(test.options, test.source))
        .rejects.toThrow('Scheduled backup failed');
      expect(test.wasResumed()).toBe(true);
      expect(await listBackups(test.directory)).toEqual([]);
      expect(await readdir(test.directory)).toEqual([]);
    });
}

it('refuses a changed position rather than publishing a mixed backup', async function movedPoint() {
  const test = await fixture();
  let reads = 0;
  function verify() {
    reads++;
    if (reads === 2) return Promise.resolve({ ...test.point, sequence: 43 });
    return Promise.resolve(test.point);
  }
  test.source.verify = verify;
  await expect(captureScheduledBackup(test.options, test.source)).rejects.toThrow();
  expect(await listBackups(test.directory)).toEqual([]);
  expect(test.wasResumed()).toBe(true);
});

it('does not report corrupted saved bytes as a complete backup', async function corruptPart() {
  const test = await fixture();
  await captureScheduledBackup(test.options, test.source);
  await writeFile(join(test.directory, 'backup-one', 'files'), 'changed bytes');
  await expect(listBackups(test.directory)).rejects.toThrow('Backup bytes differ');
});

it('leaves an interrupted capture alone and refuses overlapping work', async function overlap() {
  const test = await fixture();
  await writeFile(join(test.directory, '.lock'), 'interrupted');
  await expect(captureScheduledBackup(test.options, test.source)).rejects.toThrow();
  expect(await listBackups(test.directory)).toEqual([]);
  expect(await readFile(join(test.directory, '.lock'), 'utf8')).toBe('interrupted');
});

it('preserves an interrupted private directory if its id is reused', async function staleDirectory() {
  const test = await fixture();
  const { mkdir } = await import('node:fs/promises');
  await mkdir(join(test.directory, '.backup-one'), { mode: 0o700 });
  await writeFile(join(test.directory, '.backup-one', 'kept'), 'interrupted bytes');
  await expect(captureScheduledBackup(test.options, test.source)).rejects.toThrow();
  expect(await readFile(join(test.directory, '.backup-one', 'kept'), 'utf8'))
    .toBe('interrupted bytes');
});

it('refuses a lagging secondary projection before any part is captured', async function laggingReadTable() {
  const test = await fixture();
  test.point.checkpoints = { files: 42, groups: 41 };
  await expect(captureScheduledBackup(test.options, test.source)).rejects.toThrow();
  expect(await listBackups(test.directory)).toEqual([]);
  expect(test.observations).toEqual([]);
  expect(test.wasResumed()).toBe(true);
});

it('keeps a visible maintenance lock when admission cannot be restored', async function resumeFailed() {
  const test = await fixture();
  function resume() { return Promise.reject(new Error('scale unavailable')); }
  test.source.resume = resume;
  await expect(captureScheduledBackup(test.options, test.source)).rejects.toThrow();
  expect(await listBackups(test.directory)).toEqual([]);
  expect(await readFile(join(test.directory, '.lock'), 'utf8')).toContain('backup-one');
});

for (const failure of ['write', 'sync'] as const) {
  for (const stage of ['parts', 'resume'] as const) {
    it(`retains maintenance after restart and marker ${failure} fail during ${stage}`,
      async function maintenanceStorageFailure() {
        const test = await fixture();
        const probe = await open(join(test.directory, 'probe'), 'wx');
        const prototype: unknown = Object.getPrototypeOf(probe);
        if (!isMaintenanceHandle(prototype)) throw new Error('Missing file handle methods');
        await probe.close();
        await rm(join(test.directory, 'probe'));
        const originalWrite: unknown = Reflect.get(prototype, 'writeFile');
        const originalSync: unknown = Reflect.get(prototype, 'sync');
        if (typeof originalWrite !== 'function' || typeof originalSync !== 'function') {
          throw new Error('Missing file handle implementations');
        }
        let markerAttempted = false;
        async function writeMarker(this: FileHandle, ...args: Parameters<FileHandle['writeFile']>) {
          if (args[0] === '\nresume_failed\n') {
            markerAttempted = true;
            if (failure === 'write') throw new Error('private-volume-full-canary');
          }
          await Reflect.apply(originalWrite, this, args);
        }
        async function syncMarker(this: FileHandle) {
          if (markerAttempted && failure === 'sync') {
            throw new Error('private-volume-sync-canary');
          }
          await Reflect.apply(originalSync, this, []);
        }
        function restartFailure() {
          return Promise.reject(new Error('private-scale-failure-canary'));
        }
        function partFailure(): Promise<never> {
          return Promise.reject(new Error('private-part-failure-canary'));
        }
        test.source.resume = restartFailure;
        if (stage === 'parts') test.source.parts.files = partFailure;
        vi.spyOn(prototype, 'writeFile').mockImplementation(writeMarker);
        vi.spyOn(prototype, 'sync').mockImplementation(syncMarker);
        function captureError(error: unknown) { return error; }
        try {
          const error = await captureScheduledBackup(test.options, test.source).catch(captureError);
          expect(markerAttempted).toBe(true);
          expect(test.wasResumed()).toBe(false);
          expect(await listBackups(test.directory)).toEqual([]);
          expect(await readFile(join(test.directory, '.lock'), 'utf8')).toContain('backup-one');
          expect(await readFile(join(test.directory, '.backup-one', 'events'), 'utf8'))
            .toBe('events at sequence 42');
          expect(error).toBeInstanceOf(Error);
          if (!(error instanceof Error)) throw new Error('Missing maintenance failure');
          expect(error.message)
            .toBe('Maintenance remains active; services could not restart');
          expect(error.cause)
            .toEqual({ kind: 'scheduled_backup', reason: 'resume_marker' });
          await expect(captureScheduledBackup(test.options, test.source)).rejects.toThrow();
        } finally {
          vi.restoreAllMocks();
        }
      });
  }
}

it('attempts every saved restart even when the first scale command fails', async function resumesAll() {
  const { natsFixture } = await import('@opencrane/event-store/testing');
  const { packageBackupSource } = await import('./scheduled-backup-source.ts');
  const { chmod } = await import('node:fs/promises');
  const nats = await natsFixture();
  const test = await fixture();
  const command = join(test.directory, 'kubectl');
  const calls = join(test.directory, 'calls');
  const script = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.BACKUP_TEST_CALLS, args.join(' ') + '\\n');
if (args[0] === 'get') console.log(JSON.stringify({spec: {replicas: 1}}));
if (args[0] === 'scale' && args[1] === 'deployment/worker-dispatcher' &&
    args.includes('--replicas=0')) process.exit(1);
if (args[0] === 'scale' && args[1] === 'deployment/server' &&
    args.includes('--replicas=1')) process.exit(1);
`;
  await writeFile(command, script);
  await chmod(command, 0o700);
  for (const [name, value] of Object.entries(nats.env())) vi.stubEnv(name, value);
  vi.stubEnv('PATH', `${test.directory}:${process.env['PATH']}`);
  vi.stubEnv('BACKUP_TEST_CALLS', calls);
  const runtime = await packageBackupSource(test.options);
  try {
    await expect(runtime.source.pause()).rejects.toThrow();
    await expect(runtime.source.resume()).rejects.toThrow('Backup replicas remain stopped');
    expect(await readFile(calls, 'utf8')).toContain('scale deployment/worker-dispatcher --replicas=1');
  } finally {
    await runtime.close();
    await nats.close();
    vi.unstubAllEnvs();
  }
});
