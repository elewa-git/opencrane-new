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
  /** Check this subject through expectedSequence and find no earlier matching command. */
  historyChecked?: true;
  /** Check the whole category, such as member-*, instead of one entity. */
  expectedSubject?: string;
  /** Use the full saved history only while changing event ownership. */
  expectedGlobalSequence?: number;
}
export type AppendResult =
  | { status: "appended"; sequence: number }
  | { status: "conflict" }
  | { status: "unavailable"; cause: unknown }
  | { status: "rejected"; reason: "invalid_event" | "duplicate_id" };

/** Events use names like member-alice; NATS changes that to ev.member.alice. */
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
    command.expectedSequence < 0 ||
    !validHistoryChecked(command.historyChecked)
  ) {
    return undefined;
  }
  const event = parsed.event;
  if (!validMigrationFence(command, event)) {
    return undefined;
  }
  if (command.expectedSubject !== undefined && command.expectedSubject !== event.subject
    && command.expectedSubject !== `${getEventDefinition(event.type)?.stream}-*`) {
    return undefined;
  }
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

function validHistoryChecked(value: unknown): boolean {
  return value === undefined || value === true;
}

function validMigrationFence(command: AppendCommand, event: EventEnvelope) {
  const sequence = command.expectedGlobalSequence;
  if (sequence === undefined) {
    return true;
  }
  return event.type === 'ownership.seeded' && Number.isSafeInteger(sequence) && sequence >= 0;
}

export function sameCommand(a: EventEnvelope, b: EventEnvelope): boolean {
  return (
    a.commandId === b.commandId &&
    a.subject === b.subject &&
    a.principal?.id === b.principal?.id &&
    a.principal?.kind === b.principal?.kind
  );
}
