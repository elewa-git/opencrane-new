import { sameCommand, type AppendCommand, type AppendOutcome, type AppendResult, type EventStore,
  type StoredEvent } from '@opencrane/event-store';
import type { EventEnvelope } from '@opencrane/events';

export class BudgetWriter {
  sequence = 0;
  private ownershipLost = false;
  private pending: { event: EventEnvelope; expectedSequence: number;
    possiblyPublished: boolean } | undefined;
  private readonly store: EventStore;
  private readonly silo: string;
  private readonly apply: (row: StoredEvent) => void;
  constructor(store: EventStore, silo: string, apply: (row: StoredEvent) => void) {
    this.store = store;
    this.silo = silo;
    this.apply = apply;
  }

  get status() {
    if (this.ownershipLost) {
      return 'ownership-lost';
    }
    if (this.pending) {
      return 'recovering';
    }
    return 'ready';
  }

  accept(row: StoredEvent) {
    if (row.sequence <= this.sequence) {
      return;
    }
    this.apply(row);
    // Advance only after application succeeds. Failed application must be retried from this row.
    this.sequence = row.sequence;
  }

  private reconcile(row: StoredEvent) {
    if (row.event.silo !== this.silo || row.event.subject !== `budget-${this.silo}`) {
      throw new Error('Budget recovery mismatch');
    }
    const own = this.pending && sameCommand(row.event, this.pending.event);
    if (!own && row.event.type !== 'provider.managed_calls_enabled') {
      this.ownershipLost = true;
      throw new Error('Budget writer lost its fence');
    }
    this.accept(row);
  }

  async recover(deadline: number) {
    if (this.ownershipLost) {
      throw new Error('Budget writer unavailable');
    }
    if (!this.pending) {
      return;
    }
    for await (const row of this.store.readStream(`budget-${this.silo}`, this.sequence + 1, deadline)) {
      this.reconcile(row);
    }
    this.finishRecovery(deadline);
  }

  private finishRecovery(deadline: number) {
    if (performance.now() >= deadline) {
      throw new Error('Budget writer unavailable');
    }
    // An empty snapshot cannot rule out a publish still travelling to NATS.
    if (this.pending?.possiblyPublished && this.sequence === this.pending.expectedSequence) {
      throw new Error('Budget writer unavailable');
    }
    this.pending = undefined;
  }

  async append(event: EventEnvelope, deadline: number, validate: () => void,
    checkAccess?: () => Promise<void>) {
    for (;;) {
      validate();
      if (performance.now() >= deadline) {
        throw new Error('Budget append unavailable');
      }
      const command: AppendCommand = { event, expectedSequence: this.sequence,
        historyChecked: true, deadline, ...(checkAccess ? { checkAccess } : {}) };
      this.pending = { event, expectedSequence: this.sequence, possiblyPublished: true };
      // Keep the command before entering storage: an exception cannot prove it was not sent.
      const result = await this.store.append(command);
      const outcome = result.outcome;
      if (result.status === 'appended') {
        await this.complete(event, result, deadline, checkAccess);
        return;
      }
      this.refuse(result);
      if (outcome?.kind === 'conditional_rejection_changed' ||
          outcome?.kind === 'conditional_rejection_unchanged') {
        for (const row of outcome.rows) {
          this.reconcile(row);
        }
        this.finishRecovery(deadline);
      } else {
        await this.recover(deadline);
      }
      if (!checkAccess && this.sequence === command.expectedSequence) {
        throw new Error('Budget append contention');
      }
      await checkAccess?.();
    }
  }

  private refuse(result: Exclude<AppendResult, { status: 'appended' }>) {
    const outcome = result.outcome;
    this.retainEvidence(outcome);
    if (result.status === 'rejected') {
      if (!outcome || !this.pending?.possiblyPublished) {
        this.pending = undefined;
      }
      throw new Error(`Budget append rejected: ${result.reason}`);
    }
    if (result.status === 'unavailable') {
      if (outcome?.kind === 'transport_failure' && !outcome.possiblyPublished) {
        this.pending = undefined;
      }
      throw new Error('Budget append unavailable');
    }
  }

  private retainEvidence(outcome: AppendOutcome | undefined) {
    if (!outcome || !this.pending) {
      return;
    }
    switch (outcome.kind) {
      case 'appended':
      case 'duplicate_saved':
        return;
      case 'conditional_rejection_unchanged':
      case 'conditional_rejection_changed':
      case 'conditional_rejection_unknown':
      case 'transport_failure':
      case 'rejected':
        this.pending.possiblyPublished = outcome.possiblyPublished;
    }
  }

  private async complete(event: EventEnvelope,
    result: Extract<AppendResult, { status: 'appended' }>, deadline: number,
    checkAccess?: () => Promise<void>) {
    let saved = { sequence: result.sequence, event };
    if (result.outcome?.kind === 'duplicate_saved') {
      saved = result.outcome.saved;
    }
    if (!result.outcome) {
      saved = await this.store.readEvent(result.sequence, deadline);
    }
    if (!sameCommand(saved.event, event)) {
      throw new Error('Budget receipt mismatch');
    }
    const consumed = saved.sequence <= this.sequence;
    this.accept(saved);
    if (!consumed && result.outcome?.kind === 'duplicate_saved') {
      await this.recover(deadline);
    }
    this.pending = undefined;
    if (consumed && event.type === 'budget.call_dispatch_admitted') {
      throw new Error('Dispatch already admitted');
    }
    await checkAccess?.();
    if (performance.now() >= deadline) {
      throw new Error('Budget append unavailable');
    }
  }
}

export async function withinBudgetDeadline<Value>(work: Promise<Value>, deadline: number) {
  const expired = Promise.withResolvers<never>();
  function refuse() {
    expired.reject(new Error('Budget append unavailable'));
  }
  const timer = setTimeout(refuse, Math.max(0, deadline - performance.now()));
  try {
    const result = await Promise.race([work, expired.promise]);
    if (performance.now() >= deadline) {
      throw new Error('Budget append unavailable');
    }
    return result;
  } finally {
    clearTimeout(timer);
  }
}
