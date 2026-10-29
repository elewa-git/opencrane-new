import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { personalRecallQualified } from '../../apps/server/src/chat/recall-qualification.ts';

export const checks = ['privateTurns', 'nativeRecall', 'requesterIsolation', 'sessionIsolation',
  'invalidation', 'unrelatedActivity', 'stopReconnect', 'replacementReload', 'persistence'];
export const qualifications = ['P4-14', 'P4-15'];
const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const bindingSchema = z.strictObject({
  sourceSha: z.string(), imageDigest: z.string(), environmentId: z.string(),
  runId: z.uuid(), installationId: z.uuid(), freshInstall: z.literal(true),
});
const expectedSchema = bindingSchema.extend({ evidenceDigest: digestSchema });
const rowSchema = z.strictObject({
  name: z.string(), result: z.literal('PASS'), receiptDigest: digestSchema,
});
const evidenceSchema = bindingSchema.extend({
  result: z.literal('PASS'), checks: z.array(rowSchema).length(9),
  qualifications: z.array(rowSchema).length(2),
});
const receiptSchema = bindingSchema.extend({
  name: z.string(), result: z.literal('PASS'), complete: z.literal(true),
});
type Binding = z.infer<typeof bindingSchema>;
type Reason = 'evidence_invalid' | 'evidence_changed' | 'binding_invalid' | 'checks_invalid'
  | 'receipt_invalid' | 'deployment_changed' | 'collection_failed';

class Refusal extends Error {
  readonly reason: Reason;

  constructor(reason: Reason) {
    super(reason);
    this.reason = reason;
  }
}

function readBounded(file: string, limit: number, reason: Reason): Buffer {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size === 0 || stat.size > limit) {
      throw new Refusal(reason);
    }
    const bytes = Buffer.alloc(limit + 1);
    const length = readSync(descriptor, bytes, 0, bytes.length, 0);
    if (length !== stat.size || length > limit) {
      throw new Refusal(reason);
    }
    return bytes.subarray(0, length);
  } catch {
    throw new Refusal(reason);
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
}

function parse(bytes: Buffer, reason: Reason): unknown {
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    throw new Refusal(reason);
  }
}

function verifyDigest(bytes: Buffer, expected: string, reason: Reason): void {
  const hash = createHash('sha256');
  hash.update(bytes);
  const actual = `sha256:${hash.digest('hex')}`;
  if (actual !== expected) {
    throw new Refusal(reason);
  }
}

function sameBinding(expected: Binding, actual: unknown): boolean {
  const parsed = bindingSchema.strip().safeParse(actual);
  if (!parsed.success) {
    return false;
  }
  for (const field of Object.keys(bindingSchema.shape)) {
    if (Reflect.get(expected, field) !== Reflect.get(parsed.data, field)) {
      return false;
    }
  }
  return true;
}

function checkNames(rows: z.infer<typeof rowSchema>[], required: string[]): void {
  const seen = new Set<string>();
  for (const row of rows) {
    if (!required.includes(row.name) || seen.has(row.name)) {
      throw new Refusal('checks_invalid');
    }
    seen.add(row.name);
  }
}

function collectFiles(file: string, expected: z.infer<typeof expectedSchema>): void {
  const bytes = readBounded(file, 65_536, 'evidence_invalid');
  const input = parse(bytes, 'evidence_invalid');
  verifyDigest(bytes, expected.evidenceDigest, 'evidence_changed');
  if (!sameBinding(expected, input)) {
    throw new Refusal('binding_invalid');
  }
  const parsed = evidenceSchema.safeParse(input);
  if (!parsed.success) {
    throw new Refusal('checks_invalid');
  }
  const evidence = parsed.data;
  checkNames(evidence.checks, checks);
  checkNames(evidence.qualifications, qualifications);
  for (const row of [...evidence.checks, ...evidence.qualifications]) {
    const path = join(dirname(file), `${row.receiptDigest.slice(7)}.json`);
    const receiptBytes = readBounded(path, 16_384, 'receipt_invalid');
    verifyDigest(receiptBytes, row.receiptDigest, 'receipt_invalid');
    const receipt = receiptSchema.safeParse(parse(receiptBytes, 'receipt_invalid'));
    if (!receipt.success || receipt.data.name !== row.name || !sameBinding(expected, receipt.data)) {
      throw new Refusal('receipt_invalid');
    }
  }
}

function validateExpected(input: unknown): z.infer<typeof expectedSchema> {
  const parsed = expectedSchema.safeParse(input);
  if (!parsed.success) {
    throw new Refusal('binding_invalid');
  }
  const { sourceSha, imageDigest, environmentId } = parsed.data;
  const runtime = { sourceSha, imageDigest, environmentId };
  const results: Record<string, 'PASS'> = {};
  for (const name of checks) {
    results[name] = 'PASS';
  }
  const shape = { ...runtime, result: 'PASS', checks: results };
  // Reuse the server's identity contract without treating parsing as live proof.
  if (!personalRecallQualified(runtime, shape)) {
    throw new Refusal('binding_invalid');
  }
  return parsed.data;
}

export async function collectEvidence(
  file: string, expectedRun: unknown, observeDeployment: () => Promise<unknown>,
): Promise<{ result: 'FAIL' | 'NOT RUN'; reason: Reason | 'live_launch_unavailable' }> {
  try {
    const expected = validateExpected(expectedRun);
    const before = await observeDeployment();
    if (!sameBinding(expected, before)) {
      throw new Refusal('deployment_changed');
    }
    collectFiles(file, expected);
    const after = await observeDeployment();
    if (!sameBinding(expected, after)) {
      throw new Refusal('deployment_changed');
    }
    // Re-read after the child returns so changed files cannot survive a delayed observation.
    collectFiles(file, expected);
    return { result: 'NOT RUN', reason: 'live_launch_unavailable' };
  } catch (error) {
    if (error instanceof Refusal) {
      return { result: 'FAIL', reason: error.reason };
    }
    return { result: 'FAIL', reason: 'collection_failed' };
  }
}
