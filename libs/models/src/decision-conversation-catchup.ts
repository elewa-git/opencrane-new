import { peekStreamSummary, readStreamSummary, type EventStore, type StoredEvent }
  from '@opencrane/event-store';
import { createLogger } from '@opencrane/observability';
import { decisionChatSummary } from './decision-summary.ts';

export class ConversationHistoryApplying extends Error {
  constructor() {
    super('Conversation history is catching up. Please try again shortly.');
  }
}

const pending = new WeakMap<EventStore, Set<string>>();
const logger = createLogger('conversation-history');

export function caughtUpConversation(store: EventStore, silo: string,
  conversationId: string, capturedPosition: number, latest: number) {
  const subject = `conversation-${conversationId}`;
  function snapshot(rows: StoredEvent[], sequence: number) {
    function captured(row: StoredEvent) {
      return row.sequence <= capturedPosition;
    }
    return { conversation: rows.filter(captured), sequence: Math.min(sequence, capturedPosition) };
  }
  const ready = peekStreamSummary(store, silo, subject, decisionChatSummary, latest);
  if (ready) {
    return snapshot(ready.summary, ready.sequence);
  }
  startCatchup(store, silo, subject);
  throw new ConversationHistoryApplying();
}

function startCatchup(store: EventStore, silo: string, subject: string) {
  let subjects = pending.get(store);
  if (!subjects) {
    subjects = new Set();
    pending.set(store, subjects);
  }
  if (subjects.has(subject)) {
    return;
  }
  subjects.add(subject);
  const activeSubjects = subjects;
  function complete() {
    activeSubjects.delete(subject);
  }
  function failed(error: unknown) {
    logger.warn({ err: error }, 'Conversation history catch-up failed');
    complete();
  }
  function discard() {
    // Let later decisions copy the completed summary without retaining another result.
  }
  // Catch up independently after refusing the request. Never extend its access deadline.
  const deadline = store.clock.now() + 10_000;
  const catchingUp = readStreamSummary(store, silo, subject, decisionChatSummary, deadline, discard);
  void catchingUp.then(complete, failed);
}
