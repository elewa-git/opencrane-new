import {
  handlerSubscriptions,
  type HandlerName,
  type EventEnvelope,
} from "@opencrane/events";
import type { Query } from "@opencrane/projections";

export interface HandlerAttempt {
  signal: AbortSignal;
  deadline: number;
}

export interface Handler {
  readonly name: HandlerName;
  readonly eventTypes: readonly string[];
  // Write SQL through this transaction. External calls need their own safe
  // retry rule because a local receipt cannot make them part of this commit.
  handle(event: EventEnvelope, transaction: Query, attempt?: HandlerAttempt): Promise<void>;
  // Handle exhaustion only when the reaction saves durable failure evidence.
  exhausted?(event: EventEnvelope): Promise<boolean>;
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
