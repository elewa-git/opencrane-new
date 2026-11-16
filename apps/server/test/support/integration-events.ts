import { getEventDefinition, parseEventByType, type EventEnvelope } from '@opencrane/events';
import type { natsFixture } from '@opencrane/event-store/testing';
import { history } from '@opencrane/models';
import { expect } from 'vitest';

export function integrationEvent(type: string, subject: string, data: Record<string, unknown>,
  eventNumber: number, silo: string): EventEnvelope {
  const definition = getEventDefinition(type);
  if (!definition || typeof definition.example !== 'object' || definition.example === null) {
    throw new Error('Bad fixture type');
  }
  const eventData: Record<string, unknown> = { ...definition.example, ...data };
  if (type === 'mcp.server_registered' && !Object.hasOwn(data, 'catalogueRef')) {
    delete eventData['catalogueRef'];
  }
  if (type === 'mcp.server_discovered' && !Object.hasOwn(data, 'serverInfo')) {
    delete eventData['serverInfo'];
  }
  const reference = `integration-${eventNumber}`;
  const time = `2026-10-01T00:${String(eventNumber).padStart(2, '0')}:00Z`;
  const candidate = { id: reference, commandId: reference, type, source: 'test', time,
    subject, silo, principal: { id: 'admin', kind: 'human' }, data: eventData };
  const parsed = parseEventByType(candidate);
  if (!parsed.success) {
    throw new Error(`Bad ${type} fixture: ${parsed.reason}`);
  }
  return parsed.event;
}

export async function seedStoredEvent(nats: Awaited<ReturnType<typeof natsFixture>>,
  stored: EventEnvelope) {
  // Keep old incomplete snapshots in read and rebuild tests, outside the new-write path.
  await nats.seed([stored]);
  const rows = await history(nats.store, stored.subject, stored.silo);
  expect(rows.at(-1)?.event).toEqual(stored);
  return nats.store.head(stored.subject);
}
