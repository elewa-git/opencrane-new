import type { EventEnvelope } from '@opencrane/events';
import { event } from '@opencrane/event-store/testing';

export function routineEvent(id: string, subject: string, type: string,
  data: unknown): EventEnvelope {
  const template = event(id, subject, type);
  return { ...template, source: 'opencrane-server', commandId: id, data };
}
