import type { EventStore } from '@opencrane/event-store';
import type { Logger } from '@opencrane/observability';
import type { Db } from '@opencrane/projections';
import type { connectionCustody } from './connection-custody.ts';
import { reconcileConnectionPage } from './connection-reconciliation.ts';

const scanIntervalMs = 15 * 60 * 1000;

/** Check private copies during live maintenance. Keep page details inside this loop. */
export async function scanConnections(store: EventStore, db: Pick<Db, 'lock'>,
  custody: ReturnType<typeof connectionCustody>, logger: Pick<Logger, 'info'>,
  silo: string, signal: AbortSignal, intervalMs = scanIntervalMs): Promise<void> {
  let continuation: string | undefined;
  let previousUnknown = false;
  async function pass() {
    while (!signal.aborted) {
      const page = await reconcileConnectionPage(store, db, custody, silo, continuation);
      if (page.status === 'unknown') {
        if (previousUnknown) {
          continuation = undefined;
        }
        previousUnknown = !previousUnknown;
        return;
      }
      previousUnknown = false;
      const counts = { examined: page.examined, deleted: page.deleted };
      logger.info(counts, 'Connection custody page scanned');
      continuation = page.continuation;
      if (!continuation) {
        return;
      }
    }
  }
  let tick = Promise.withResolvers<void>();
  function wake() {
    tick.resolve();
  }
  const timer = setInterval(wake, intervalMs);
  signal.addEventListener('abort', wake, { once: true });
  try {
    while (!signal.aborted) {
      await pass();
      // Skip ticks during work so slow pages cannot start overlapping or queued passes.
      tick = Promise.withResolvers<void>();
      if (!signal.aborted) {
        await tick.promise;
      }
    }
  } finally {
    clearInterval(timer);
    signal.removeEventListener('abort', wake);
  }
}
