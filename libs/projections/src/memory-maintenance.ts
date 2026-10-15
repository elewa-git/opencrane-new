import type { z } from 'zod';
import { memoryMaintenanceRecordedDataSchema } from '@opencrane/events';

type Run = z.infer<typeof memoryMaintenanceRecordedDataSchema>;

export type MaintenanceFact = {
  memoryId: string;
  revision: number;
  expiresAt: string | null;
  pinned: boolean;
  position: number;
  status: string;
  encryptedBytes: number;
};

export type MaintenanceReference = {
  memoryId: string;
  revision: number;
  expiresAt: string | null;
  position: number;
};

function oldest(first: MaintenanceFact, second: MaintenanceFact): number {
  const firstId = Buffer.from(first.memoryId);
  const secondId = Buffer.from(second.memoryId);
  return first.position - second.position || Buffer.compare(firstId, secondId);
}

function reviewedAt(fact: MaintenanceFact, runs: Run[]): string | null {
  let latest: string | null = null;
  for (const run of runs) {
    if (run.action !== 'no_changes') {
      continue;
    }
    for (const reference of run.inputRefs) {
      if (reference.memoryId !== fact.memoryId || reference.revision !== fact.revision ||
          reference.position !== fact.position || reference.expiresAt !== fact.expiresAt) {
        continue;
      }
      if (latest === null || Date.parse(run.intendedAt) > Date.parse(latest)) {
        latest = run.intendedAt;
      }
    }
  }
  return latest;
}

function isDirty(fact: MaintenanceFact, runs: Run[], intendedAt: string): boolean {
  const reviewed = reviewedAt(fact, runs);
  if (reviewed === null) {
    return true;
  }
  if (fact.expiresAt === null || fact.pinned) {
    return false;
  }
  const expiry = Date.parse(fact.expiresAt);
  return expiry <= Date.parse(intendedAt) && Date.parse(reviewed) < expiry;
}

function inputReference(fact: MaintenanceFact): MaintenanceReference {
  return { memoryId: fact.memoryId, revision: fact.revision,
    expiresAt: fact.expiresAt, position: fact.position };
}

function escapedBlockBytes(fact: MaintenanceFact, reference: MaintenanceReference,
  intendedAt: string): number {
  const emptyEntry = { reference, value: '' };
  const encodedEntry = JSON.stringify(emptyEntry);
  const metadataBytes = Buffer.byteLength(encodedEntry);
  const expired = !fact.pinned && fact.expiresAt !== null &&
    Date.parse(fact.expiresAt) <= Date.parse(intendedAt);
  // Reserve twice the plain byte count for JSON escaping without opening a key.
  const escapedBytes = expired ? 0 : Math.max(0, fact.encryptedBytes - 28) * 2;
  return metadataBytes + escapedBytes + 1;
}

function eligibleFact(fact: MaintenanceFact, runs: Run[], intendedAt: string): boolean {
  if ((fact.status !== 'available' && fact.status !== 'unavailable') ||
      !isDirty(fact, runs, intendedAt)) {
    return false;
  }
  return !fact.pinned || fact.expiresAt === null ||
    Date.parse(fact.expiresAt) > Date.parse(intendedAt);
}

/** Choose whole facts from metadata only. A large first fact cannot be bypassed. */
export function selectMaintenanceInputs(facts: MaintenanceFact[], runs: Run[],
  lastChangePosition: number, lastForgetPosition: number, intendedAt: string) {
  let reviewedPosition = 0;
  for (const run of runs) {
    if (run.action === 'no_changes') {
      reviewedPosition = Math.max(reviewedPosition, run.reviewedPosition ?? 0);
    }
  }
  const eligible: MaintenanceFact[] = [];
  for (const fact of facts) {
    if (eligibleFact(fact, runs, intendedAt)) {
      eligible.push(fact);
    }
  }
  eligible.sort(oldest);
  const inputRefs: MaintenanceReference[] = [];
  let bytes = Buffer.byteLength('{"facts":[]}');
  for (const fact of eligible) {
    if (inputRefs.length === 32) {
      break;
    }
    const reference = inputReference(fact);
    const nextBytes = escapedBlockBytes(fact, reference, intendedAt);
    if (bytes + nextBytes > 16_384) {
      break;
    }
    inputRefs.push(reference);
    bytes += nextBytes;
  }
  return { inputRefs, waitingCount: eligible.length, reviewedPosition,
    lastChangePosition, dirty: eligible.length > 0 || lastForgetPosition > reviewedPosition };
}
