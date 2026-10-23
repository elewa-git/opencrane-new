import type { ComputerControl } from '@opencrane/auth';
import type { EventStore } from '@opencrane/event-store';

type Control = Exclude<ComputerControl, { phase: 'unverified' }>;
const deadlines = new WeakMap<EventStore, Map<string, number>>();

export function pauseDeadline(store: EventStore, silo: string, control: Control) {
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
  return deadline;
}

export function pauseTimeRemaining(store: EventStore, silo: string, control: Control) {
  const deadline = pauseDeadline(store, silo, control);
  return Math.max(0, deadline - performance.now());
}
