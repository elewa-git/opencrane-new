import { fileUploadedDataSchema } from '@opencrane/events';
import type { Query } from '@opencrane/projections';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { descriptorSchema } from './event-backup.ts';

export const maximumPilotObjects = 10_000;
export const pilotFileEntrySchema = z.object({ key: z.string().min(1).max(1024),
  byteCount: z.int().nonnegative().max(64 * 1024 * 1024),
  sha256: descriptorSchema.shape.sha256 }).strict();
export const pilotFileDetailsSchema = z.object({
  bucket: z.literal('files'), objects: z.array(pilotFileEntrySchema).max(maximumPilotObjects),
}).strict();

type FileEntry = z.infer<typeof pilotFileEntrySchema>;

export async function readPilotFileReferences(database: Query, silo: string) {
  const references = await database.query<{ data: unknown }>(
    'SELECT data FROM conversation_files WHERE silo=$1 LIMIT $2', [silo, maximumPilotObjects + 1]);
  if (references.rows.length > maximumPilotObjects) throw new Error('Too many event file references');
  const expected = new Map<string, FileEntry>();
  for (const { data } of references.rows) {
    const file = fileUploadedDataSchema.parse(data);
    const entry = { key: file.objectKey, byteCount: file.size, sha256: file.sha256 };
    const previous = expected.get(entry.key);
    if (previous && !isDeepStrictEqual(previous, entry)) {
      throw new Error('Conflicting event file references');
    }
    expected.set(entry.key, entry);
  }
  return expected;
}

export function checkPilotFileInventory(expected: ReadonlyMap<string, FileEntry>,
  entries: FileEntry[]) {
  if (expected.size !== entries.length) throw new Error('Event file inventory differs');
  const checked = new Set<string>();
  for (const entry of entries) {
    if (checked.has(entry.key) || !isDeepStrictEqual(expected.get(entry.key), entry)) {
      throw new Error('File differs from events');
    }
    checked.add(entry.key);
  }
}
