export { connectNats, isEventStoreUnavailable } from "./nats-connection.ts";
export { createEventStore, connectEventStore, EventStore } from "./jetstream.ts";
export {
  wireSubject,
  decodeEvent,
  type AppendCommand,
  type AppendResult,
  type StoredEvent,
} from "./contract.ts";
export { readEventAt } from './read-event-at.ts';
export { readStreamSummary, WrongSiloError, type SummaryKind } from './stream-summary.ts';
