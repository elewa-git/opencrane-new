import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { hashBackupBytes } from './backup-bytes.ts';
import { descriptorSchema } from './event-backup.ts';
import { readPrivateFile } from './event-restore.ts';
import { manifestSchema, maximumManifestBytes, showBackup } from './scheduled-backup.ts';
import { pilotFileDetailsSchema, pilotFileEntrySchema } from './pilot-file-inventory.ts';
import { pilotProjectionNames } from './pilot-projections.ts';
import type { PilotRestoreOptions } from './pilot-restore.ts';

const storeReference = descriptorSchema.shape.attempt.refine(isBoundStore);
const accessFields = { storeId: storeReference, modelId: storeReference };
const accessObject = z.object(accessFields);
const databaseFields = {
  databases: z.array(z.string()),
  lsn: manifestSchema.shape.point.shape.lsn,
  access: accessObject.strict(),
};
const databaseObject = z.object(databaseFields);
export const pilotDatabaseDetailsSchema = databaseObject.strict();

function isBoundStore(value: string) {
  return value !== 'pending';
}

export type CheckedPilotBackup = {
  manifest: z.infer<typeof manifestSchema>;
  manifestDigest: string;
  events: z.infer<typeof descriptorSchema>;
  files: z.infer<typeof pilotFileDetailsSchema>;
  database: z.infer<typeof pilotDatabaseDetailsSchema>;
  objects: Map<string, Buffer>;
  bytes: Record<'events' | 'database' | 'files', Buffer>;
};

function validatePositions(manifest: CheckedPilotBackup['manifest'], providerMode?: boolean) {
  const actualNames = Object.keys(manifest.point.checkpoints);
  actualNames.sort();
  const expectedNames = pilotProjectionNames(providerMode);
  const names = [...expectedNames, 'dispatcher'];
  names.sort();
  if (!isDeepStrictEqual(actualNames, names)) {
    throw new Error('Checkpoint inventory differs');
  }
  const start = Date.parse(manifest.startedAt);
  const stop = Date.parse(manifest.stoppedAt);
  const complete = Date.parse(manifest.completedAt);
  if (start > stop || stop > complete) {
    throw new Error('Backup dates differ');
  }
  for (const part of Object.values(manifest.parts)) {
    if (Date.parse(part.startedAt) < stop || Date.parse(part.finishedAt) > complete ||
        Date.parse(part.startedAt) > Date.parse(part.finishedAt)) {
      throw new Error('Part dates differ');
    }
  }
}

function validateEventPoint(events: CheckedPilotBackup['events'],
  manifest: CheckedPilotBackup['manifest']): void {
  if (events.silo !== manifest.silo || events.attempt !== manifest.id ||
      events.lastSequence !== manifest.point.sequence || events.config['num_replicas'] !== 1 ||
      !isDeepStrictEqual(events.config['subjects'], ['ev.>']) ||
      events.sha256 !== manifest.parts.events.sha256 ||
      events.byteCount !== manifest.parts.events.byteCount) {
    throw new Error('Event point differs');
  }
}

export async function checkPilotBackup(options: PilotRestoreOptions): Promise<CheckedPilotBackup> {
  const manifest = await showBackup(options.directory, options.id);
  if (manifest.silo !== options.silo || !isDeepStrictEqual(manifest.images, options.images) ||
      Object.keys(options.images).length !== 8) {
    throw new Error('Package version differs');
  }
  for (const image of Object.values(manifest.images)) {
    if (!/@sha256:[a-f0-9]{64}$/u.test(image)) {
      throw new Error('Image pin refused');
    }
  }
  validatePositions(manifest, options.providerMode);
  const events = descriptorSchema.parse(manifest.parts.events.details);
  validateEventPoint(events, manifest);
  const database = pilotDatabaseDetailsSchema.parse(manifest.parts.database.details);
  const databases = [...database.databases];
  databases.sort();
  if (database.lsn !== manifest.point.lsn ||
      !isDeepStrictEqual(databases, ['handlers', 'openfga', 'postgres', 'projections'])) {
    throw new Error('Database inventory differs');
  }
  const files = pilotFileDetailsSchema.parse(manifest.parts.files.details);
  const directory = join(options.directory, options.id);
  const bytes = {
    events: checkedPart(directory, manifest.parts.events),
    database: checkedPart(directory, manifest.parts.database),
    files: checkedPart(directory, manifest.parts.files),
  };
  const manifestPath = join(directory, 'manifest.json');
  const manifestBytes = readPrivateFile(manifestPath, maximumManifestBytes);
  const manifestText = manifestBytes.toString('utf8');
  const savedManifest = JSON.parse(manifestText);
  const reread = manifestSchema.parse(savedManifest);
  if (!isDeepStrictEqual(reread, manifest)) {
    throw new Error('Manifest changed');
  }
  const manifestDigest = hashBackupBytes(manifestBytes);
  const objects = decodeFiles(files, bytes.files);
  return { manifest, manifestDigest, events, files, database, bytes, objects };
}

function decodeFiles(details: CheckedPilotBackup['files'], bytes: Buffer) {
  const fileDataSchema = z.string();
  const entryFields = { data: fileDataSchema.max(90 * 1024 * 1024) };
  const entrySchema = pilotFileEntrySchema.extend(entryFields);
  const inventory = new Map<string, z.infer<typeof pilotFileEntrySchema>>();
  for (const entry of details.objects) {
    if (inventory.has(entry.key)) {
      throw new Error('Duplicate object inventory');
    }
    inventory.set(entry.key, entry);
  }
  const objects = new Map<string, Buffer>();
  let lines: string[] = [];
  if (bytes.length) {
    const content = bytes.toString('utf8');
    lines = content.split('\n');
  }
  if (lines.length !== inventory.size) {
    throw new Error('Object inventory differs');
  }
  let total = 0;
  for (const line of lines) {
    const value = JSON.parse(line);
    const entry = entrySchema.parse(value);
    const { data, ...metadata } = entry;
    if (objects.has(entry.key) || !isDeepStrictEqual(metadata, inventory.get(entry.key))) {
      throw new Error('Object reference differs');
    }
    const decoded = Buffer.from(data, 'base64');
    total += decoded.length;
    if (total > 64 * 1024 * 1024 || decoded.length !== entry.byteCount ||
        decoded.toString('base64') !== data || hashBackupBytes(decoded) !== entry.sha256) {
      throw new Error('Object bytes differ');
    }
    objects.set(entry.key, decoded);
  }
  return objects;
}

function checkedPart(directory: string, part: CheckedPilotBackup['manifest']['parts']['events']) {
  const path = join(directory, part.path);
  const bytes = readPrivateFile(path, 128 * 1024 * 1024);
  if (bytes.length !== part.byteCount || hashBackupBytes(bytes) !== part.sha256) {
    throw new Error('Backup changed');
  }
  return bytes;
}
