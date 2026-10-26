import { z } from 'zod';

const runtimeSchema = z.strictObject({
  sourceSha: z.string().regex(/^[a-f0-9]{40}$/u),
  imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  environmentId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/u),
});

const passed = z.literal('PASS');
const qualificationSchema = runtimeSchema.extend({
  result: passed,
  checks: z.strictObject({
    privateTurns: passed,
    nativeRecall: passed,
    requesterIsolation: passed,
    sessionIsolation: passed,
    invalidation: passed,
    unrelatedActivity: passed,
    stopReconnect: passed,
    replacementReload: passed,
    persistence: passed,
  }),
});

// Accept only deployment-owned evidence; never use a browser or computer claim here.
export function personalRecallQualified(runtime: unknown, qualification: unknown): boolean {
  const current = runtimeSchema.safeParse(runtime);
  const checked = qualificationSchema.safeParse(qualification);
  if (!current.success || !checked.success) {
    return false;
  }
  return current.data.sourceSha === checked.data.sourceSha
    && current.data.imageDigest === checked.data.imageDigest
    && current.data.environmentId === checked.data.environmentId;
}
