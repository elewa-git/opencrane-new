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
  async function pause() {
    stopped = true;
    return point;
  }
  async function verify() {
    expect(stopped).toBe(true);
    observations.push('verify');
    return point;
  }
  async function capture(destination: string) {
    expect(stopped).toBe(true);
    const name = destination.split('/').at(-1)!;
    observations.push(name);
    await writeFile(destination, `${name} at sequence 42`);
    return { position: 42 };
  }
  async function resume() {
    stopped = false;
    resumed = true;
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
