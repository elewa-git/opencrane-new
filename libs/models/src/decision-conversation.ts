import { caughtUpConversation } from './decision-conversation-catchup.ts';
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
    // Translate the remaining budget because PostgreSQL deadlines use performance.now().
    const projectionStarted = performance.now();
    const remaining = request.deadline - store.clock.now();
    const lookup = {
      ...request,
      deadline: projectionStarted + remaining,
      silo,
      metadataTypes,
      latestTypes,
      ignoredTypes: outputReportTypes,
    };
    const indexed = await decisionConversationPositions(db, lookup);
    if (indexed.checkpointPosition > request.head) {
      const latest = await store.head(undefined, request.deadline);
      if (latest < indexed.checkpointPosition) {
        throw new Error('Conversation projection is beyond saved history');
      }
    }
    const conversation: StoredEvent[] = [];
    const subject = `conversation-${request.conversationId}`;
    // Read changes after the projection's saved position, including both close formats.
    const latest = await store.head(subject, request.deadline, true);
    const through = Math.min(latest, request.head);
    // Allow for positions in other streams. This bound also caps
    // the number of conversation events read inside the original access deadline.
    if (through - indexed.position > 64) {
      return caughtUpConversation(store, silo, request.conversationId, request.head, through);
    }
    for (const entry of indexed.rows) {
      const position = Number(entry.position);
      if (position > through) {
        throw new Error('Conversation projection is beyond saved history');
      }
      let row: StoredEvent;
      if (entry.type === 'conversation.created') {
        const creationRead = {
          silo,
          subject,
          position,
          type: 'conversation.created',
          deadline: request.deadline,
        };
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
    if (through > indexed.position) {
      const changes = store.readStream(subject, indexed.position + 1,
        request.deadline, true, through);
      for await (const row of changes) {
        if (row.event.silo !== silo) {
          throw new Error('Wrong silo');
        }
        conversation.push(row);
      }
    }
    // Keep the checked position even when the snapshot omits irrelevant output rows.
    return { conversation, sequence: through };
  }
  return read;
}
