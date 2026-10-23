import { setTimeout as delay } from 'node:timers/promises';
import { readComputerControl, type ComputerControl } from '@opencrane/auth';
import type { EventStore } from '@opencrane/event-store';
import { pauseTimeRemaining } from './bridge-pause-time.ts';
import { saveFailed } from './bridge-pausing.ts';

export async function watchTakeoverDeadline(store: EventStore, silo: string,
  assistantId: string, signal: AbortSignal) {
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
      if (control?.phase === 'requested' || control?.phase === 'pausing') {
        const remaining = pauseTimeRemaining(store, silo, control);
        if (remaining === 0) {
          await saveFailed(store, silo, control, position);
        } else {
          wait = Math.min(wait, remaining);
        }
      }
    } catch {
      // Retry the same saved transition after conflicts or outages. Work remains denied.
    }
    try {
      await delay(wait, undefined, { signal });
    } catch (error) {
      if (!signal.aborted) throw error;
    }
  }
}
