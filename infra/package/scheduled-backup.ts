import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, writeFile }
  from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { descriptorSchema } from './event-backup.ts';

const identifier = descriptorSchema.shape.attempt;
const integer = descriptorSchema.shape.lastSequence;
const pointSchema = z.object({
  sequence: integer, lsn: z.string().regex(/^[A-F0-9]+\/[A-F0-9]+$/u),
  checkpoints: z.record(z.string(), integer),
}).strict();
const partSchema = z.object({
  backupId: identifier, sequence: integer, path: z.enum(['events', 'database', 'files']),
  byteCount: integer, sha256: descriptorSchema.shape.sha256,
  startedAt: z.iso.datetime(), finishedAt: z.iso.datetime(),
  details: z.record(z.string(), z.json()),
}).strict();
const manifestSchema = z.object({
  version: z.literal(1), id: identifier, silo: identifier, point: pointSchema,
  startedAt: z.iso.datetime(), stoppedAt: z.iso.datetime(), completedAt: z.iso.datetime(),
  images: z.record(z.string(), z.string()), chartVersion: z.literal('0.1.0'),
  parts: z.object({ events: partSchema, database: partSchema, files: partSchema }).strict(),
}).strict();
export type BackupPoint = z.infer<typeof pointSchema>;
export type BackupSource = {
  pause(): Promise<BackupPoint>;
  verify(): Promise<BackupPoint>;
  resume(): Promise<void>;
  parts: Record<'events' | 'database' | 'files',
    (destination: string) => Promise<z.infer<typeof partSchema>['details']>>;
};
export type ScheduledBackupOptions = {
  directory: string; id: string; silo: string; images: Record<string, string>;
};

async function privateDirectory(directory: string) {
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.uid !== process.getuid?.() ||
      (metadata.mode & 0o777) !== 0o700 || await realpath(directory) !== resolve(directory)) {
    throw new Error('Backup directory refused');
  }
}

async function fingerprint(path: string) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.size > 128 * 1024 * 1024) {
    throw new Error('Backup part refused');
  }
  const bytes = await readFile(path);
  return { byteCount: bytes.length, sha256: hashBackupBytes(bytes) };
}

export function hashBackupBytes(bytes: Buffer) {
  const hash = createHash('sha256');
  hash.update(bytes);
  return hash.digest('hex');
}

function drained(point: BackupPoint) {
  for (const [name, position] of Object.entries(point.checkpoints)) {
    if (position > point.sequence || (name !== 'dispatcher' && position !== point.sequence)) {
      throw new Error('Read table position differs');
    }
  }
}

async function resume(source: BackupSource, lock: Awaited<ReturnType<typeof open>>) {
  try {
    await source.resume();
  } catch {
    let reason = 'resume';
    try {
      await lock.writeFile('\nresume_failed\n');
      await lock.sync();
    } catch {
      reason = 'resume_marker';
    }
    // Keep both failure stages without exposing dependency output or credentials.
    const cause = { kind: 'scheduled_backup', reason };
    throw new Error('Maintenance remains active; services could not restart', { cause });
  }
}

async function captureParts(source: BackupSource, directory: string, id: string, sequence: number) {
  const parts: Partial<z.infer<typeof manifestSchema>['parts']> = {};
  for (const name of ['events', 'database', 'files'] as const) {
    const startedAt = new Date().toISOString();
    const path = join(directory, name);
    const details = await source.parts[name](path);
    const file = await open(path, 'r');
    try {
      await file.sync();
    } finally {
      await file.close();
    }
    const bytes = await fingerprint(path);
    parts[name] = { backupId: id, sequence, path: name, ...bytes, details,
      startedAt, finishedAt: new Date().toISOString() };
  }
  return parts;
}

/** Publish only after all writers stayed stopped and every part was checked. */
export async function captureScheduledBackup(options: ScheduledBackupOptions, source: BackupSource) {
  identifier.parse(options.id);
  identifier.parse(options.silo);
  await privateDirectory(options.directory);
  const lock = await open(join(options.directory, '.lock'), 'wx', 0o600);
  const temporary = join(options.directory, `.${options.id}`);
  let stage = 'prepare';
  let paused = false;
  let owned = false;
  let resumed = true;
  try {
    const startedAt = new Date().toISOString();
    await lock.writeFile(JSON.stringify({ backupId: options.id, startedAt }));
    await lock.sync();
    await mkdir(temporary, { mode: 0o700 });
    owned = true;
    stage = 'pause';
    paused = true;
    const point = pointSchema.parse(await source.pause());
    drained(point);
    const stoppedAt = new Date().toISOString();
    if (!isDeepStrictEqual(point, await source.verify())) throw new Error('Point moved');
    stage = 'parts';
    const parts = await captureParts(source, temporary, options.id, point.sequence);
    stage = 'verify';
    if (!isDeepStrictEqual(point, await source.verify())) throw new Error('Point moved');
    stage = 'resume';
    paused = false;
    // Retain the lock until restart succeeds, even if recording its failure also fails.
    resumed = false;
    await resume(source, lock);
    resumed = true;
    const manifest = manifestSchema.parse({ version: 1, id: options.id, silo: options.silo,
      point, parts, startedAt, stoppedAt, completedAt: new Date().toISOString(),
      images: options.images, chartVersion: '0.1.0' });
    stage = 'publish';
    await writeFile(join(temporary, 'manifest.json'), JSON.stringify(manifest, null, 2),
      { mode: 0o600, flag: 'wx', flush: true });
    await rename(temporary, join(options.directory, options.id));
    return manifest;
  } catch (error) {
    if (!resumed) throw error;
    // Dependency output may contain credentials or file content. Keep only the failed stage.
    const cause = { kind: 'scheduled_backup', reason: stage };
    // eslint-disable-next-line preserve-caught-error -- Withhold credential-bearing dependency output.
    throw new Error('Scheduled backup failed', { cause });
  } finally {
    try {
      if (paused) {
        resumed = false;
        await resume(source, lock);
        resumed = true;
      }
    } finally {
      await lock.close();
      if (resumed) {
        if (owned) await rm(temporary, { recursive: true, force: true });
        await rm(join(options.directory, '.lock'));
      }
    }
  }
}

export async function showBackup(directory: string, id: string) {
  identifier.parse(id);
  await privateDirectory(directory);
  const backup = join(directory, id);
  await privateDirectory(backup);
  const bytes = await readFile(join(backup, 'manifest.json'), 'utf8');
  const manifest = manifestSchema.parse(JSON.parse(bytes));
  if (manifest.id !== id) throw new Error('Backup identity differs');
  drained(manifest.point);
  for (const name of ['events', 'database', 'files'] as const) {
    const part = manifest.parts[name];
    const actual = await fingerprint(join(backup, name));
    if (part.backupId !== id || part.sequence !== manifest.point.sequence ||
        part.path !== name || actual.byteCount !== part.byteCount || actual.sha256 !== part.sha256) {
      throw new Error('Backup bytes differ');
    }
  }
  return manifest;
}

export async function listBackups(directory: string) {
  await privateDirectory(directory);
  const names = await readdir(directory);
  names.sort();
  const backups = [];
  for (const name of names) {
    if (name.startsWith('.')) continue;
    backups.push(await showBackup(directory, name));
  }
  return backups;
}
