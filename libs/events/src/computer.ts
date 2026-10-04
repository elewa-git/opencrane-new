import type { EventEnvelope } from './envelope.ts';

/** A failed or abandoned takeover stays fenced, including across Pod replacement. */
export function computerWorkPaused(events: EventEnvelope[]): boolean {
  const takeover = events.findLast(event => event.type.startsWith('takeover.'));
  if (!takeover) return false;
  const data = takeover.data;
  return takeover.type !== 'takeover.ended' || typeof data !== 'object' || data === null || !('reason' in data) || data.reason !== 'released';
}
