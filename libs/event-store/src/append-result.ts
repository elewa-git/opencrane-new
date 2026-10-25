import { sameCommand, type AppendOutcome, type AppendResult, type StoredEvent } from './contract.ts';
import type { EventEnvelope } from '@opencrane/events';

export function savedAppend(saved: StoredEvent): AppendResult {
  const result = { status: 'appended' as const, sequence: saved.sequence };
  const outcome = { kind: 'duplicate_saved' as const, saved };
  return appendResult(result, outcome);
}

export function unavailableAppend(cause: unknown, possiblyPublished: boolean,
  kind: 'transport_failure' | 'conditional_rejection_unknown' = 'transport_failure'): AppendResult {
  const result = { status: 'unavailable' as const, cause };
  const outcome = { kind, possiblyPublished };
  return appendResult(result, outcome);
}

export function rejectedAppend(reason: 'invalid_event' | 'duplicate_id',
  possiblyPublished = false): AppendResult {
  const result = { status: 'rejected' as const, reason };
  const outcome = { kind: 'rejected' as const, reason, possiblyPublished };
  return appendResult(result, outcome);
}

export async function previousAppend(rows: AsyncIterable<StoredEvent>, event: EventEnvelope) {
  for await (const row of rows) {
    if (sameCommand(row.event, event)) {
      return savedAppend(row);
    }
  }
  return undefined;
}

export async function recoverAppend(rows: AsyncIterable<StoredEvent>, event: EventEnvelope,
  expectedSequence: number, possiblyPublished: boolean): Promise<AppendResult> {
  const changes: StoredEvent[] = [];
  try {
    for await (const row of rows) {
      if (sameCommand(row.event, event)) {
        return savedAppend(row);
      }
      if (row.sequence > expectedSequence) changes.push(row);
    }
    let kind: 'conditional_rejection_changed' | 'conditional_rejection_unchanged';
    if (changes.length > 0) {
      kind = 'conditional_rejection_changed';
    } else {
      kind = 'conditional_rejection_unchanged';
    }
    const outcome = { kind, rows: changes, possiblyPublished } as const;
    if (possiblyPublished) {
      const result = { status: 'unavailable' as const, cause: new Error('Earlier publish unresolved') };
      return appendResult(result, outcome);
    }
    const result = { status: 'conflict' as const };
    return appendResult(result, outcome);
  } catch (cause) {
    // Preserve earlier lost replies even though this particular attempt was rejected.
    return unavailableAppend(cause, possiblyPublished, 'conditional_rejection_unknown');
  }
}

export function appendResult(result: AppendResult, outcome: AppendOutcome): AppendResult {
  // Keep recovery history private when an existing caller serialises an append receipt.
  const descriptor = { value: outcome, enumerable: false };
  Object.defineProperty(result, 'outcome', descriptor);
  return result;
}
