import { z } from 'zod';
import { egressDestinationDataSchema } from './egress.ts';

// Keep the whole request together so older registrations cannot look newly queued.
export const hostedImageInstallationSchema = z.strictObject({
  attemptId: z.literal(1),
  platform: z.enum(['linux/amd64', 'linux/arm64']),
  upstream: egressDestinationDataSchema.pick({ host: true, port: true }),
});

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const dated = z.strictObject({
  checkedAt: z.iso.datetime(), expiresAt: z.iso.datetime(), engineVersion: z.string().min(1).max(200),
});
const database = { databaseDigest: digest, databaseUpdatedAt: z.iso.datetime() };
function verdicts<Fields extends z.ZodRawShape>(fields: Fields) {
  const receipt = dated.extend(fields);
  return z.discriminatedUnion('verdict', [
    receipt.extend({ verdict: z.literal('pass'), reportDigest: digest }),
    receipt.extend({ verdict: z.literal('fail'), reportDigest: digest,
      reasonCodes: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,79}$/u)).min(1).max(32) }),
    receipt.extend({ verdict: z.literal('unavailable'), reportDigest: digest.optional() }),
    z.strictObject({ verdict: z.literal('not_run') }),
  ]);
}
export const hostedImageCheckedSchema = z.strictObject({
  serverId: z.string().regex(/^[\w-]{1,200}$/u), attemptId: z.literal(1), imageDigest: digest,
  platform: hostedImageInstallationSchema.shape.platform,
  checks: z.strictObject({ signature: verdicts({}), licence: verdicts({}),
    vulnerability: verdicts(database), malware: verdicts(database) }),
}).refine(permitsUnrunChecks);

function permitsUnrunChecks(result: { checks: Record<string, { verdict: string }> }) {
  let failed = false;
  let skipped = false;
  for (const check of Object.values(result.checks)) {
    if (check.verdict === 'fail') failed = true;
    if (check.verdict === 'not_run') skipped = true;
  }
  return !skipped || failed;
}
