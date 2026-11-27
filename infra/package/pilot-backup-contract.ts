import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { hashBackupBytes } from './backup-bytes.ts';
import { descriptorSchema } from './event-backup.ts';
import { readPrivateFile } from './event-restore.ts';
import { manifestSchema, maximumManifestBytes, readBackupPart, showBackup }
  from './scheduled-backup.ts';
import { pilotFileDetailsSchema, pilotFileEntrySchema } from './pilot-file-inventory.ts';
import { pilotProjectionNames } from './pilot-projections.ts';
import { MemberKeysUnavailable, openMemberKeyArchive, type MemberKeyArchive }
  from './pilot-member-keys.ts';
import type { PilotRestoreOptions } from './pilot-restore.ts';

const storeReference = descriptorSchema.shape.attempt.refine(isBoundStore);
export const pilotDatabaseDetailsSchema = z.object({ databases: z.array(z.string()),
  lsn: manifestSchema.shape.point.shape.lsn,
  access: z.object({ storeId: storeReference, modelId: storeReference }).strict(),
}).strict();

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
  keys: MemberKeyArchive;
  bytes: Record<'events' | 'database' | 'files', Buffer>;
};

function validatePositions(manifest: CheckedPilotBackup['manifest'], providerMode?: boolean) {
  const actualNames = Object.keys(manifest.point.checkpoints).sort();
  const expectedNames = pilotProjectionNames(providerMode);
  const names = [...expectedNames, 'dispatcher', 'memory'].sort();
  if (!isDeepStrictEqual(actualNames, names)) throw new Error('Checkpoint inventory differs');
  const start = Date.parse(manifest.startedAt);
  const stop = Date.parse(manifest.stoppedAt);
  const complete = Date.parse(manifest.completedAt);
  if (start > stop || stop > complete) throw new Error('Backup dates differ');
  for (const part of Object.values(manifest.parts)) {
    if (!part) continue;
    if (Date.parse(part.startedAt) < stop || Date.parse(part.finishedAt) > complete ||
        Date.parse(part.startedAt) > Date.parse(part.finishedAt)) {
      throw new Error('Part dates differ');
    }
  }
}

export async function checkPilotBackup(options: PilotRestoreOptions): Promise<CheckedPilotBackup> {
  const manifest = await showBackup(options.directory, options.id);
  const directory = join(options.directory, options.id);
  const keyPart = manifest.parts['member-keys'];
  if (!keyPart || keyPart.details['encryption'] !== 'aes-256-gcm') {
    throw new MemberKeysUnavailable();
  }
  const keyBytes = checkedPart(directory, keyPart);
  const identity = { id: manifest.id, silo: manifest.silo, sequence: manifest.point.sequence };
  const keys = openMemberKeyArchive(keyBytes, identity, options.backupKeyFile);
  if (manifest.silo !== options.silo || !isDeepStrictEqual(manifest.images, options.images) ||
      Object.keys(options.images).length !== 8) throw new Error('Package version differs');
  for (const image of Object.values(manifest.images)) {
    if (!/@sha256:[a-f0-9]{64}$/u.test(image)) throw new Error('Image pin refused');
  }
  validatePositions(manifest, options.providerMode);
  const events = descriptorSchema.parse(manifest.parts.events.details);
  if (events.silo !== manifest.silo || events.attempt !== manifest.id ||
      events.lastSequence !== manifest.point.sequence || events.config['num_replicas'] !== 1 ||
      !isDeepStrictEqual(events.config['subjects'], ['ev.>']) ||
      events.sha256 !== manifest.parts.events.sha256 ||
      events.byteCount !== manifest.parts.events.byteCount) throw new Error('Event point differs');
  const database = pilotDatabaseDetailsSchema.parse(manifest.parts.database.details);
  const databases = [...database.databases].sort();
  if (database.lsn !== manifest.point.lsn ||
      !isDeepStrictEqual(databases, ['handlers', 'openfga', 'postgres', 'projections'])) {
    throw new Error('Database inventory differs');
  }
  const files = pilotFileDetailsSchema.parse(manifest.parts.files.details);
  const bytes = {
    events: checkedPart(directory, manifest.parts.events),
    database: checkedPart(directory, manifest.parts.database),
    files: checkedPart(directory, manifest.parts.files),
  };
  const manifestBytes = readPrivateFile(join(directory, 'manifest.json'), maximumManifestBytes);
  const reread = manifestSchema.parse(JSON.parse(manifestBytes.toString('utf8')));
  if (!isDeepStrictEqual(reread, manifest)) throw new Error('Manifest changed');
  const manifestDigest = hashBackupBytes(manifestBytes);
  const objects = decodeFiles(files, bytes.files);
  return { manifest, manifestDigest, events, files, database, bytes, objects, keys };
}

function decodeFiles(details: CheckedPilotBackup['files'], bytes: Buffer) {
  const entrySchema = pilotFileEntrySchema.extend({ data: z.string().max(90 * 1024 * 1024) });
  const inventory = new Map<string, z.infer<typeof pilotFileEntrySchema>>();
  for (const entry of details.objects) {
    if (inventory.has(entry.key)) throw new Error('Duplicate object inventory');
    inventory.set(entry.key, entry);
  }
  const objects = new Map<string, Buffer>();
  const lines = bytes.length ? bytes.toString('utf8').split('\n') : [];
  if (lines.length !== inventory.size) throw new Error('Object inventory differs');
  let total = 0;
  for (const line of lines) {
    const entry = entrySchema.parse(JSON.parse(line));
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
  const bytes = readBackupPart(directory, part.path);
  if (bytes.length !== part.byteCount || hashBackupBytes(bytes) !== part.sha256) {
    throw new Error('Backup changed');
  }
  return bytes;
}
