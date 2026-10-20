import { setTimeout as delay } from 'node:timers/promises';
import { readComputerControl, type ComputerControl } from '@opencrane/auth';
import type { EventStore } from '@opencrane/event-store';
import { saveFailed } from './bridge-pausing.ts';

type Control = Exclude<ComputerControl, { phase: 'unverified' }>;
const deadlines = new WeakMap<EventStore, Map<string, number>>();

export function pauseTimeRemaining(store: EventStore, silo: string, control: Control) {
  let observed = deadlines.get(store);
  if (!observed) {
    observed = new Map();
    deadlines.set(store, observed);
  }
  const key = JSON.stringify([silo, control.assistantId, control.takeoverId]);
  const now = performance.now();
  const wallRemaining = Date.parse(control.requestedAt) + 30_000 - Date.now();
  const remaining = Number.isFinite(wallRemaining) ? Math.max(0, wallRemaining) : 0;
  // Keep the first observation across polls and connections. Clock changes can only shorten it.
  const deadline = Math.min(observed.get(key) ?? Infinity, now + Math.min(30_000, remaining));
  observed.set(key, deadline);
  return Math.max(0, deadline - now);
}

export async function watchTakeoverDeadline(store: EventStore, silo: string,
  assistantId: string, signal: AbortSignal) {
  while (!signal.aborted) {
    let wait = 250;
    try {
      const position = await store.head(`computer-${assistantId}`);
      const control = await readComputerControl(store, silo, assistantId);
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
