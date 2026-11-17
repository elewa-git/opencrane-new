import { outputReportTypes } from './authority.ts';
import { decisionConversationPositions, type Query } from '@opencrane/projections';
import { readFirstEvent, type EventStore, type StoredEvent }
  from '@opencrane/event-store';

export type DecisionConversationRead = {
  conversationId: string;
  turnId: string;
  deadline: number;
  head: number;
};
export type DecisionConversationReader = (request: DecisionConversationRead) =>
  Promise<{ conversation: StoredEvent[]; sequence: number }>;

const metadataTypes = [
  'conversation.created', 'conversation.closed', 'participant.added', 'participant.removed',
];
const latestTypes = ['message.posted', 'agent.turn_started'];

export function decisionConversationReader(store: EventStore, db: Query,
  silo: string): DecisionConversationReader {
  async function read(request: DecisionConversationRead) {
    const lookup = { ...request, silo, metadataTypes, latestTypes,
      ignoredTypes: outputReportTypes };
    const indexed = await decisionConversationPositions(db, lookup);
    if (indexed.checkpointPosition > request.head) {
      const latest = await store.head(undefined, request.deadline);
      if (latest < indexed.checkpointPosition) {
        throw new Error('Conversation projection is beyond saved history');
      }
    }
    const conversation: StoredEvent[] = [];
    const subject = `conversation-${request.conversationId}`;
    for (const entry of indexed.rows) {
      const position = Number(entry.position);
      let row: StoredEvent;
      if (entry.type === 'conversation.created') {
        const creationRead = { silo, subject, position, type: 'conversation.created',
          deadline: request.deadline };
        row = await readFirstEvent(store, creationRead);
      } else {
        row = await store.readEvent(position, request.deadline);
      }
      if (row.event.silo !== silo || row.event.id !== entry.event_id ||
          (row.event.subject !== subject &&
           row.event.subject !== `participation-${request.conversationId}`)) {
        throw new Error('Conversation projection does not match saved history');
      }
      conversation.push(row);
    }
    // Read changes after the projection's saved position, including both close formats.
    const latest = await store.head(subject, request.deadline, true);
    const through = Math.min(latest, request.head);
    if (through > indexed.position) {
      const changes = store.readStream(subject, indexed.position + 1,
        request.deadline, true, through);
      for await (const row of changes) {
        if (row.event.silo !== silo) throw new Error('Wrong silo');
        conversation.push(row);
      }
    }
    return { conversation, sequence: conversation.at(-1)?.sequence ?? 0 };
  }
  return read;
}
