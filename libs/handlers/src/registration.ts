import {
  handlerSubscriptions,
  type HandlerName,
  type EventEnvelope,
} from "@opencrane/events";
import type { Query } from "@opencrane/projections";

export interface Handler {
  readonly name: HandlerName;
  readonly eventTypes: readonly string[];
  // SQL effects must use this transaction. External effects need their own
  // event-id idempotency protocol; a local receipt cannot make them atomic.
  handle(event: EventEnvelope, transaction: Query): Promise<void>;
}
export function registerHandler(
  name: HandlerName,
  handle: Handler["handle"],
): Handler {
  return Object.freeze({
    name,
    eventTypes: handlerSubscriptions[name],
    handle,
  });
}
export function checkHandlers(handlers: readonly Handler[]): string {
  const names = new Set<string>();
  for (const handler of handlers) {
    if (
      names.has(handler.name) ||
      JSON.stringify(handler.eventTypes) !==
        JSON.stringify(handlerSubscriptions[handler.name])
    ) {
      throw new Error(
        "Duplicate handler or subscriptions differ from catalogue",
      );
    }
    names.add(handler.name);
  }
  return JSON.stringify(
    handlers
      .map(({ name, eventTypes }) => ({ name, eventTypes }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  );
}
