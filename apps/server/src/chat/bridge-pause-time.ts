import type { ComputerControl } from '@opencrane/auth';
import type { EventStore } from '@opencrane/event-store';

type Control = Exclude<ComputerControl, { phase: 'unverified' }>;
const deadlines = new WeakMap<EventStore, Map<string, { takeoverId: string; deadline: number }>>();

export function pauseDeadline(store: EventStore, silo: string, control: Control) {
  if (control.phase !== 'requested' && control.phase !== 'pausing') {
    return performance.now();
  }
  let observed = deadlines.get(store);
  if (!observed) {
    observed = new Map();
    deadlines.set(store, observed);
  }
  const key = JSON.stringify([silo, control.assistantId]);
  const now = performance.now();
  const wallRemaining = Date.parse(control.requestedAt) + 30_000 - Date.now();
  const remaining = Number.isFinite(wallRemaining) ? Math.max(0, wallRemaining) : 0;
  // Keep the first observation across polls and connections. Clock changes can only shorten it.
  const previous = observed.get(key);
  let originalDeadline = Infinity;
  if (previous?.takeoverId === control.takeoverId) originalDeadline = previous.deadline;
  const deadline = Math.min(originalDeadline, now + Math.min(30_000, remaining));
  const observation = { takeoverId: control.takeoverId, deadline };
  observed.set(key, observation);
  return deadline;
}

export function pauseTimeRemaining(store: EventStore, silo: string, control: Control) {
  const deadline = pauseDeadline(store, silo, control);
  return Math.max(0, deadline - performance.now());
}

export function forgetPauseDeadline(store: EventStore, silo: string, assistantId: string) {
  const key = JSON.stringify([silo, assistantId]);
  const observed = deadlines.get(store);
  observed?.delete(key);
}
