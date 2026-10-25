import type { AppendCommand, AppendOutcome, EventStore, StoredEvent } from '@opencrane/event-store';
import type { EventEnvelope } from '@opencrane/events';

export function budgetAppendCommand(event: EventEnvelope, expectedSequence: number,
  checkAccess: (() => Promise<void>) | undefined, deadline: number | undefined): AppendCommand {
  // Reuse replayed history; configure checks its caller's command id before this append.
  return { event, expectedSequence, historyChecked: true,
    ...(checkAccess ? { checkAccess } : {}),
    ...(deadline === undefined ? {} : { deadline }) };
}

export class BudgetWriterChanged extends Error {
  constructor() {
    super('Budget writer lost its fence');
  }
}

export async function savedBudgetEvent(store: EventStore, result: AppendOutcome,
  attempted: EventEnvelope, deadline: number): Promise<StoredEvent> {
  switch (result.status) {
    case 'appended':
      return { sequence: result.sequence, event: attempted };
    case 'duplicate_saved': {
      // Apply the saved event, not a retry's potentially different payload.
      const saved = await store.readEvent(result.sequence, deadline);
      if (saved.event.silo !== attempted.silo || saved.event.subject !== attempted.subject) {
        throw new BudgetWriterChanged();
      }
      return saved;
    }
    case 'rejected':
      throw new Error(`Budget append rejected: ${result.reason}`);
    case 'conditional_rejection_unknown':
    case 'transport_failure':
      throw new Error('Budget append unavailable', { cause: result.cause });
    case 'conditional_rejection_changed':
    case 'conditional_rejection_unchanged':
      throw new Error('Budget append contention');
  }
}

export async function unchangedBudgetPosition(store: EventStore, silo: string,
  sequence: number, deadline: number): Promise<number | undefined> {
  const subject = `budget-${silo}`;
  let position = sequence;
  for await (const row of store.readStream(subject, sequence + 1, deadline)) {
    // Refuse another budget writer's changes. Only switch-on leaves money untouched.
    if (row.event.silo !== silo || row.event.subject !== subject ||
        row.event.type !== 'provider.managed_calls_enabled') {
      return undefined;
    }
    position = row.sequence;
  }
  return position;
}
