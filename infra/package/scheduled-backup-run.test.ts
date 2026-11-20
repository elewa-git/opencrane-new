import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { captureScheduledBackup } from './scheduled-backup.ts';

// Catalogue reads must work without loading capture clients or service credentials.
vi.mock('./scheduled-backup-source.ts', function refuseCaptureRuntime() {
  throw new Error('Capture runtime loaded during catalogue read');
});

const directories: string[] = [];

afterEach(async function clean() {
  vi.restoreAllMocks();
  for (const directory of directories) await rm(directory, { recursive: true, force: true });
});

it('lists and shows checked backup bytes without loading the capture runtime',
  async function readsCatalogueOffline() {
    const directory = await mkdtemp(join(tmpdir(), 'backup-catalogue-'));
    directories.push(directory);
    const point = { sequence: 1, lsn: '0/123', checkpoints: { files: 1 } };
    async function position() { return point; }
    async function resume() { /* No running services in an offline catalogue. */ }
    async function capture(destination: string) {
      await writeFile(destination, 'saved bytes', { mode: 0o600 });
      return { position: 1 };
    }
    const source = { pause: position, verify: position, resume,
      parts: { events: capture, database: capture, files: capture } };
    const options = { directory, id: 'saved-backup', silo: 'test', images: { server: 'test' } };
    const manifest = await captureScheduledBackup(options, source);
    const writes: string[] = [];
    function output(bytes: string | Uint8Array) {
      writes.push(String(bytes));
      return true;
    }
    vi.spyOn(process.stdout, 'write').mockImplementation(output);
    const { runBackupCommand } = await import('./scheduled-backup-run.ts');
    await runBackupCommand(['list'], directory);
    expect(JSON.parse(writes.pop()!)).toEqual([manifest]);
    await runBackupCommand(['show', 'saved-backup'], directory);
    expect(JSON.parse(writes.pop()!)).toEqual(manifest);
  });
