import { event } from '@opencrane/event-store/testing';
import type { EventStore } from '@opencrane/event-store';
import { getEventDefinition, routineDefinitionSchema,
  type EventEnvelope } from '@opencrane/events';

export function routine(type: string, ownerId = 'alice', id = type): EventEnvelope {
  const saved = getEventDefinition('routine.created')?.example;
  if (typeof saved !== 'object' || !saved) {
    throw new Error('Missing routine example');
  }
  const original = routineDefinitionSchema.parse(Reflect.get(saved, 'definition'));
  const definition = { ...original, ownerId, ownerAdmissionId: `joined-${ownerId}` };
  let data: unknown = { ...saved, definition, actorId: ownerId };
  let actorId = ownerId;
  if (type !== 'routine.created') {
    actorId = 'admin';
    const control = { version: 1, routineId: 'orders', definitionRevision: 2,
      scheduleRevision: 1, controlRevision: 2, actorId, source: 'admin',
      reason: 'admin_requested', affectedRun: null, next: null };
    data = control;
    if (type === 'routine.reassigned') {
      data = { ...control, definition };
    }
  }
  return { ...event(id, 'routine-orders', type), source: 'opencrane-server',
    commandId: id, principal: { kind: 'human', id: actorId }, data };
}

export function joinedMember(memberId: string): EventEnvelope {
  const joined = event(`joined-${memberId}`, `member-${memberId}`);
  let role = 'member';
  if (memberId === 'admin') {
    role = 'admin';
  }
  const data = { ...joined.data, role };
  return { ...joined, data };
}

export function history(events: EventEnvelope[]): Pick<EventStore, 'readStream'> {
  async function* readStream(subject: string, fromSequence = 1) {
    await Promise.resolve();
    for (const [index, event] of events.entries()) {
      const sequence = index + 1;
      if (event.subject === subject && sequence >= fromSequence) {
        yield { event, sequence };
      }
    }
  }
  return { readStream };
}
