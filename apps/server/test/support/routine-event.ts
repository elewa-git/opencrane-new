import { event } from '@opencrane/event-store/testing';
import type { EventEnvelope } from '@opencrane/events';

export function routineEvent(id: string, subject: string, type: string,
  data: unknown): EventEnvelope {
  return { ...event(id, subject, type), source: 'opencrane-server', commandId: id, data };
}
