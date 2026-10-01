import {
  getEventDefinition,
  parseEventByType,
  type EventEnvelope,
} from "@opencrane/events";

export interface StoredEvent {
  sequence: number;
  event: EventEnvelope;
}
export interface AppendCommand {
  event: unknown;
  expectedSequence: number;
}
export type AppendResult =
  | { status: "appended"; sequence: number }
  | { status: "conflict" }
  | { status: "unavailable"; cause: unknown }
  | { status: "rejected"; reason: "invalid_event" | "duplicate_id" };

/** Envelope subjects use the catalogue's member-alice form; NATS uses ev.member.alice. */
export function wireSubject(subject: string): string {
  const parts = /^([a-z]+)-([^.*>\s]+)$/.exec(subject);
  if (!parts) {
    throw new Error("Invalid entity subject");
  }
  return `ev.${parts[1]}.${parts[2]}`;
}

export function decodeEvent(data: Uint8Array, subject: string): EventEnvelope {
  const input: unknown = JSON.parse(new TextDecoder().decode(data));
  const parsed = parseEventByType(input);
  if (!parsed.success || wireSubject(parsed.event.subject) !== subject) {
    throw new Error("Invalid stored event");
  }
  return parsed.event;
}

export function validateCommand(
  command: AppendCommand,
): EventEnvelope | undefined {
  const parsed = parseEventByType(command.event);
  if (
    !parsed.success ||
    !Number.isSafeInteger(command.expectedSequence) ||
    command.expectedSequence < 0
  ) {
    return undefined;
  }
  const event = parsed.event;
  if (
    !event.commandId ||
    !event.principal ||
    !/^([a-z]+)-([^.*>\s]+)$/.test(event.subject)
  ) {
    return undefined;
  }
  return event.subject.startsWith(`${getEventDefinition(event.type)?.stream}-`)
    ? event
    : undefined;
}

export function sameCommand(a: EventEnvelope, b: EventEnvelope): boolean {
  return (
    a.commandId === b.commandId &&
    a.subject === b.subject &&
    a.principal?.id === b.principal?.id &&
    a.principal?.kind === b.principal?.kind
  );
}
