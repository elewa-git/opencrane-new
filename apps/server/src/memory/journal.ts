import { closeSync, existsSync, fsyncSync, openSync, readFileSync,
  renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { memoryRevisionIdentitySchema } from '@opencrane/events';

const entrySchema = z.strictObject({ identity: memoryRevisionIdentitySchema,
  principalKind: z.enum(['human', 'agent']).default('human'),
  operation: z.enum(['forget', 'correct']).optional(),
  requester: z.string(), commandId: z.string(), inputDigest: z.string(),
  appendUntil: z.number().optional(),
  expectedSequence: z.number().int().nonnegative().optional(),
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
    const entry = entrySchema.parse(raw);
    const appendUntil = entry.appendUntil ?? statSync(path).mtimeMs + 2000;
    return { ...entry, appendUntil };
  }
  function save(entry: z.infer<typeof entrySchema>) {
    const pending = `${path}-pending`;
    writeFileSync(pending, JSON.stringify(entry), { mode: 0o600 });
    sync(pending);
    renameSync(pending, path);
    sync(directory);
  }
  function remove() {
    rmSync(path, { force: true });
    rmSync(`${path}-pending`, { force: true });
    sync(directory);
  }
  return { read, save, remove };
}
