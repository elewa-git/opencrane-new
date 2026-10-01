export { createEventStore, connectNats, connectEventStore, EventStore } from "./jetstream.ts";
export {
  wireSubject,
  decodeEvent,
  type AppendCommand,
  type AppendResult,
  type StoredEvent,
} from "./contract.ts";
