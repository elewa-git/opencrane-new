import { setTimeout as delay } from 'node:timers/promises';
import { readComputerControl, type ComputerControl } from '@opencrane/auth';
import type { Logger } from '@opencrane/observability';
import type { EventStore } from '@opencrane/event-store';
import { pauseTimeRemaining, forgetPauseDeadline } from './bridge-pause-time.ts';
import { saveFailed } from './bridge-pausing.ts';

export async function watchTakeoverDeadline(store: EventStore, silo: string,
  assistantId: string, signal: AbortSignal, logger: Logger) {
  let logged = false;
  let observedPosition: number | undefined;
  let control: ComputerControl | undefined;
  while (!signal.aborted) {
    let wait = 250;
    try {
      const position = await store.head(`computer-${assistantId}`);
      if (position !== observedPosition) {
        control = await readComputerControl(store, silo, assistantId);
        observedPosition = position;
      }
      if (signal.aborted) return;
      if (control?.phase !== 'requested' && control?.phase !== 'pausing') {
        forgetPauseDeadline(store, silo, assistantId);
        return;
      }
      const remaining = pauseTimeRemaining(store, silo, control);
      if (remaining === 0) {
        await saveFailed(store, silo, control, position);
        forgetPauseDeadline(store, silo, assistantId);
        return;
      }
      wait = Math.min(wait, remaining);
    } catch {
      // Log once per request without exposing receipts, credentials or upstream errors.
      if (!logged) {
        logged = true;
        logger.warn('Takeover deadline check unavailable; work remains blocked');
      }
    }
    try {
      await delay(wait, undefined, { signal });
    } catch (error) {
      if (!signal.aborted) throw error;
    }
  }
}
