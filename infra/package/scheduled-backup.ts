import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, writeFile }
  from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';

const identifier = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/u);
const integer = z.number().int().nonnegative().safe();
const pointSchema = z.object({
  sequence: integer, lsn: z.string().regex(/^[A-F0-9]+\/[A-F0-9]+$/u),
  checkpoints: z.record(z.string(), integer),
}).strict();
const partSchema = z.object({
  backupId: identifier, sequence: integer, path: z.enum(['events', 'database', 'files']),
  byteCount: integer, sha256: z.string().regex(/^[a-f0-9]{64}$/u),
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
  const hash = createHash('sha256');
  hash.update(bytes);
  return { byteCount: bytes.length, sha256: hash.digest('hex') };
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
  try {
    const startedAt = new Date().toISOString();
    await mkdir(temporary, { mode: 0o700 });
    stage = 'pause';
    paused = true;
    const point = pointSchema.parse(await source.pause());
    const stoppedAt = new Date().toISOString();
    if (!isDeepStrictEqual(point, await source.verify())) throw new Error('Point moved');
    const parts = {} as z.infer<typeof manifestSchema>['parts'];
    for (const name of ['events', 'database', 'files'] as const) {
      stage = name;
      const partStarted = new Date().toISOString();
      const path = join(temporary, name);
      const details = await source.parts[name](path);
      const bytes = await fingerprint(path);
      parts[name] = { backupId: options.id, sequence: point.sequence, path: name,
        ...bytes, details, startedAt: partStarted, finishedAt: new Date().toISOString() };
    }
    stage = 'verify';
    if (!isDeepStrictEqual(point, await source.verify())) throw new Error('Point moved');
    stage = 'resume';
    await source.resume();
    paused = false;
    const manifest = manifestSchema.parse({ version: 1, id: options.id, silo: options.silo,
      point, parts, startedAt, stoppedAt, completedAt: new Date().toISOString(),
      images: options.images, chartVersion: '0.1.0' });
    stage = 'publish';
    await writeFile(join(temporary, 'manifest.json'), JSON.stringify(manifest, null, 2),
      { mode: 0o600, flag: 'wx', flush: true });
    await rename(temporary, join(options.directory, options.id));
    return manifest;
  } catch {
    // Dependency output may contain credentials or file content. Keep only the failed stage.
    const cause = { kind: 'scheduled_backup', reason: stage };
    throw new Error('Scheduled backup failed', { cause });
  } finally {
    try {
      if (paused) await source.resume();
    } finally {
      await rm(temporary, { recursive: true, force: true });
      await lock.close();
      await rm(join(options.directory, '.lock'));
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
