import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { descriptorSchema } from './event-backup.ts';

const sequence = z.number().int().nonnegative().safe();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const recoverySchema = z.object({
  events: z.array(z.object({ sequence, subject: z.string(), id: z.string(),
    eventDigest: digest }).strict())
    .min(1).max(100_000),
  checkpoint: sequence,
  rowsDigest: digest,
}).strict();
export type RecoveryState = z.infer<typeof recoverySchema>;

export function checkUpgradeRecovery(before: RecoveryState, after: RecoveryState,
  archive: unknown): void {
  try {
    const expected = recoverySchema.parse(before);
    const actual = recoverySchema.parse(after);
    const descriptor = descriptorSchema.parse(archive);
    const count = expected.events.length;
    if (descriptor.firstSequence !== 1 || descriptor.lastSequence !== count ||
        descriptor.eventCount !== count || expected.checkpoint !== count ||
        !isDeepStrictEqual(expected, actual)) throw new Error();
    const identities = createHash('sha256');
    const ids = new Set<string>();
    const positions: Record<string, number> = Object.create(null);
    for (let index = 0; index < count; index++) {
      const row = expected.events[index]!;
      if (row.sequence !== index + 1 || ids.has(row.id)) throw new Error();
      ids.add(row.id);
      identities.update(JSON.stringify([row.sequence, row.subject, row.id]) + '\n');
      positions[row.subject] = row.sequence;
    }
    if (identities.digest('hex') !== descriptor.identityDigest ||
        !isDeepStrictEqual({ ...positions }, descriptor.subjectPositions)) throw new Error();
  } catch {
    throw new Error('Upgrade recovery comparison refused');
  }
}
