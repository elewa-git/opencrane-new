import type { ToolPolicy } from '@opencrane/protocol';
import { z } from 'zod';

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const readySchema = z.object({ status: z.literal('ready'),
  changeRef: z.string().regex(/^[\w-]{1,200}$/u), generation: z.int().positive(),
  fragmentDigest: digest, recordDigest: digest, configDigest: digest,
  requestedAt: z.iso.datetime(), observedAt: z.iso.datetime() });

export function isReadyPublication(
  raw: unknown, policy: ToolPolicy | undefined, requireIntent = false,
): boolean {
  const parsed = readySchema.safeParse(raw);
  if (!parsed.success || !policy?.expiresAt) return false;
  const status = parsed.data;
  const now = Date.now();
  if (Date.parse(policy.expiresAt) <= now || Date.parse(status.observedAt) > now ||
      Date.parse(status.requestedAt) > Date.parse(status.observedAt)) return false;
  if (policy.publication) {
    return policy.publication.commandId === status.changeRef &&
      policy.publication.fragmentDigest === status.fragmentDigest &&
      policy.publication.reviewRevision === policy.reviewRevision;
  }
  return !requireIntent;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isOlderPublication(policy: ToolPolicy | undefined): boolean {
  if (!policy?.driftHeld || !policy.publication) return false;
  return policy.publication.reviewRevision < policy.policyRevision;
}

export function savedSequence(value: unknown): number | null {
  if (!isRecord(value) || value['status'] !== 'appended') return null;
  const sequence = value['sequence'];
  return typeof sequence === 'number' && Number.isSafeInteger(sequence) && sequence > 0
    ? sequence : null;
}
