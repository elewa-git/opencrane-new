import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { captureScheduledBackup, listBackups, showBackup } from './scheduled-backup.ts';

const directories: string[] = [];
afterEach(async function clean() {
  for (const directory of directories) await rm(directory, { recursive: true, force: true });
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'scheduled-backup-'));
  directories.push(directory);
  let stopped = false;
  let resumed = false;
  const point = { sequence: 42, lsn: '0/123', checkpoints: { files: 42 } };
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
