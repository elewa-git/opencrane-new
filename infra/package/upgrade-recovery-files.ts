import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { fileUploadedDataSchema } from '@opencrane/events';
import type { Query } from '@opencrane/projections';
import type { storageClient } from '../../apps/server/src/files/storage.ts';

const sequenceSchema = z.number().int().nonnegative().safe();
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const comparisonSchema = z.object({
  checkpoint: sequenceSchema,
  rowCount: z.number().int().min(0).max(1_000),
  byteCount: z.number().int().min(0).max(64 * 1024 * 1024),
  rowsDigest: digestSchema,
  objectsDigest: digestSchema,
}).strict();
type FileRecovery = z.infer<typeof comparisonSchema>;
type Storage = ReturnType<typeof storageClient>;

async function hashObject(objects: Storage, data: unknown, signal: AbortSignal) {
  const file = fileUploadedDataSchema.parse(data);
  const response = await objects.getObjectBounded('files', file.objectKey,
    { signal, timeoutMs: 60_000 });
  const hash = createHash('sha256');
  let byteCount = 0;
  try {
    for await (const chunk of response) {
      signal.throwIfAborted();
      if (!Buffer.isBuffer(chunk)) throw new Error();
      byteCount += chunk.length;
      if (byteCount > file.size) throw new Error();
      hash.update(chunk);
    }
    const sha256 = hash.digest('hex');
    if (byteCount !== file.size || sha256 !== file.sha256) throw new Error();
    return { byteCount, sha256 };
  } finally {
    response.destroy();
  }
}

/** Compare complete read rows and stored bytes while writers and readers remain stopped. */
export async function collectFileRecovery(db: Query, objects: Storage): Promise<FileRecovery> {
  try {
    const options = { deadline: performance.now() + 60_000 };
    const signal = AbortSignal.timeout(60_000);
    const checkpoint = await db.query<{ sequence: string }>(
      "SELECT sequence FROM projection_checkpoints WHERE name = 'files'", [], options);
    const result = await db.query<{ data: unknown }>(
      `SELECT * FROM conversation_files AS entry
        ORDER BY to_jsonb(entry)::text COLLATE "C" LIMIT 1001`, [], options);
    if (result.rows.length > 1_000) throw new Error();
    const rows = createHash('sha256');
    rows.update(JSON.stringify(result.rows));
    const objectsHash = createHash('sha256');
    let byteCount = 0;
    for (const row of result.rows) {
      const actual = await hashObject(objects, row.data, signal);
      byteCount += actual.byteCount;
      if (byteCount > 64 * 1024 * 1024) throw new Error();
      objectsHash.update(JSON.stringify(actual));
    }
    const collected = { checkpoint: Number(checkpoint.rows[0]?.sequence),
      rowCount: result.rows.length, byteCount, rowsDigest: rows.digest('hex'),
      objectsDigest: objectsHash.digest('hex') };
    return comparisonSchema.parse(collected);
  } catch {
    throw new Error('File recovery collection refused');
  }
}

export function checkFileRecovery(before: FileRecovery, after: FileRecovery,
  archiveSequence: number): void {
  try {
    const sequence = sequenceSchema.parse(archiveSequence);
    const expected = comparisonSchema.parse(before);
    const actual = comparisonSchema.parse(after);
    if (expected.checkpoint !== sequence || actual.checkpoint !== sequence ||
        !isDeepStrictEqual(expected, actual)) throw new Error();
  } catch {
    throw new Error('File recovery comparison refused');
  }
}
