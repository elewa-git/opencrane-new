import { closeSync, existsSync, fsyncSync, openSync, readFileSync,
  renameSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { memoryRevisionIdentitySchema } from '@opencrane/events';

const entrySchema = z.strictObject({ identity: memoryRevisionIdentitySchema,
  requester: z.string(), commandId: z.string(), inputDigest: z.string(),
  stage: z.enum(['prepared', 'unknown', 'failed']) });
function sync(path: string) {
  const descriptor = openSync(path, 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}
export function commandJournal(directory: string, reference: string) {
  const path = `${directory}/command-${reference}.json`;
  function read() {
    if (!existsSync(path)) {
      return null;
    }
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return entrySchema.parse(raw);
  }
  function save(entry: z.infer<typeof entrySchema>) {
    const pending = `${path}-pending`;
    writeFileSync(pending, JSON.stringify(entry), { mode: 0o600 });
    sync(pending);
    renameSync(pending, path);
    sync(directory);
  }
  return { read, save };
}
