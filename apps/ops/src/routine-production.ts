import type { EventStore } from '@opencrane/event-store';
import type { Query } from '@opencrane/projections';
import { dispatchRoutineCandidates } from './routine-scan.ts';

type Worker = Parameters<typeof dispatchRoutineCandidates>[2];
type Handoff = NonNullable<Parameters<typeof dispatchRoutineCandidates>[3]>;

interface Delivery {
  db: Query;
  store: EventStore;
  worker: Worker;
  handoff: Handoff;
}

/** Leave disabled and replay workers without a due claim or external call. */
export async function runRoutineScheduler(options: { enabled?: boolean; replay?: boolean },
  delivery?: Delivery) {
  if (options.enabled !== true || options.replay === true) {
    return { status: 'disabled' as const, executionAvailable: false as const };
  }
  if (!delivery || typeof delivery.handoff !== 'function' ||
      typeof delivery.db?.query !== 'function' ||
      typeof delivery.store?.append !== 'function' ||
      typeof delivery.worker?.checkCurrent !== 'function' ||
      !delivery.worker.binding || !delivery.worker.signal) {
    // Refuse before an enabled host can occupy a slot without checked delivery.
    throw new Error('Routine delivery unavailable');
  }
  const { db, store, worker, handoff } = delivery;
  return dispatchRoutineCandidates(db, store, worker, handoff);
}
