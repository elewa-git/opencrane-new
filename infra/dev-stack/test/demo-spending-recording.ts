import type { EventStore, StoredEvent } from '@opencrane/event-store';

export function spendingRecording(callCount: () => number) {
  async function head() { return 10; }
  async function* readStream() {
    yield row(5, 'budget.reserved', 'old-call', { amountCents: 99, modelCall: { turnId: 'old' } });
    if (callCount() === 0) return;
    yield row(11, 'budget.reserved', 'charged-call',
      { amountCents: 20, modelCall: { turnId: 'turn-1' } });
    yield row(12, 'budget.reserved', 'held-call',
      { amountCents: 25, modelCall: { turnId: 'turn-1' } });
    yield row(13, 'budget.settled', 'charged-call', { settledCents: 4 });
    yield row(14, 'budget.settled', 'held-call', { settledCents: 0, outcome: 'unknown' });
    yield row(15, 'budget.reserved', 'other-user',
      { amountCents: 90, modelCall: { turnId: 'unrelated-turn' } });
    yield row(16, 'budget.reserved', 'unsent-call',
      { amountCents: 10, modelCall: { turnId: 'turn-1' } });
    yield row(17, 'budget.settled', 'unsent-call', { settledCents: 0, outcome: 'not_dispatched' });
  }
  return { head, readStream } as Pick<EventStore, 'head' | 'readStream'>;
}
function row(sequence: number, type: string, reservationId: string,
  extra: Record<string, unknown>): StoredEvent {
  return { sequence, event: { type, data: { reservationId, ...extra } } } as StoredEvent;
}
