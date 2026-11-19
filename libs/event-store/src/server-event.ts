import { randomUUID } from 'node:crypto';
import type { EventEnvelope } from '@opencrane/events';

export type ServerEventFields = Pick<EventEnvelope, 'silo' | 'subject' | 'type' | 'data'> &
  Partial<Pick<EventEnvelope, 'principal' | 'commandId' | 'correlation' | 'id' | 'time'>>;

export function serverEvent(fields: ServerEventFields): EventEnvelope {
  return {
    ...fields,
    id: fields.id ?? randomUUID(),
    source: 'opencrane-server',
    time: fields.time ?? new Date().toISOString(),
    correlation: fields.correlation ?? {},
  };
}
