import type { StoredEvent } from '@opencrane/event-store';
import { agentTurnStopRequestedDataSchema } from '@opencrane/events';
import type { WebSocket } from 'ws';
import { z } from 'zod';

type StopLink = {
  socket: Pick<WebSocket, 'send'>;
  sentStops: Map<string, number>;
};
const turnIdData = z.object({ turnId: z.string() });

type BudgetStop = Extract<z.infer<typeof agentTurnStopRequestedDataSchema>, { reason: 'budget' }>;

export function pendingBudgetStops(rows: StoredEvent[], closed: Set<string>) {
  const finished = new Set(closed);
  const stops = new Map<string, BudgetStop>();
  for (const row of rows) {
    if (['agent.turn_completed', 'agent.turn_failed'].includes(row.event.type)) {
      finished.add(turnIdData.parse(row.event.data).turnId);
    }
    if (row.event.type !== 'agent.turn_stop_requested') continue;
    const stop = agentTurnStopRequestedDataSchema.parse(row.event.data);
    if ('reason' in stop && !stops.has(stop.turnId)) stops.set(stop.turnId, stop);
  }
  for (const turnId of finished) stops.delete(turnId);
  return [...stops.values()];
}

export function sendBudgetStops(link: StopLink, stops: BudgetStop[]) {
  for (const stop of stops) {
    const previous = link.sentStops.get(stop.turnId);
    const now = performance.now();
    if (previous !== undefined && now - previous < 1000) continue;
    // Retry without a new event: a sent frame does not prove the computer stopped.
    const frame = { type: 'stop', turnId: stop.turnId, conversationId: stop.conversationId,
      reason: stop.reason, stopId: stop.stopId };
    link.socket.send(JSON.stringify(frame));
    link.sentStops.set(stop.turnId, now);
  }
}
