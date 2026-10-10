import { createHash } from 'node:crypto';
import {
  getEventDefinition,
  conversationEventId,
  chatIdSchema,
  groupConversationCommandSchema,
  memoryWrittenIdentity,
  memoryWrittenEventSchema,
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
  /** Stop retries when the caller's access check expires. Use performance.now(). */
  deadline?: number;
  /** Check this subject through expectedSequence and find no earlier matching command. */
  historyChecked?: true;
  /** Check the whole category, such as member-*, instead of one entity. */
  expectedSubject?: string;
  /** Check the whole log position for ownership migration or provider draining. */
  expectedGlobalSequence?: number;
}
export type AppendResult =
  | { status: "appended"; sequence: number }
  | { status: "conflict" }
  | { status: "unavailable"; cause: unknown }
  | { status: "rejected"; reason: "invalid_event" | "duplicate_id" };

/** Events use names like member-alice; NATS changes that to ev.member.alice. */
export function wireSubject(subject: string): string {
  const parts = /^(chat-state|[a-z]+)-([^.*>\s]+)$/.exec(subject);
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
    !validHistoryCheck(command)
  ) {
    return undefined;
  }
  const event = parsed.event;
  if (!validConversationWrite(event) || !validCurrentMemoryWrite(event)) {
    return undefined;
  }
  if (!validMigrationFence(command, event)) {
    return undefined;
  }
  if (!validExpectedSubject(command, event)) {
    return undefined;
  }
  if (
    !event.commandId ||
    !event.principal ||
    !/^(chat-state|[a-z]+)-([^.*>\s]+)$/.test(event.subject)
  ) {
    return undefined;
  }
  return event.subject.startsWith(`${getEventDefinition(event.type)?.stream}-`)
    ? event
    : undefined;
}

function validConversationWrite(event: EventEnvelope): boolean {
  const stream = getEventDefinition(event.type)?.stream;
  if (stream !== 'conversation' && stream !== 'participation') {
    return true;
  }
  try {
    conversationEventId(event);
  } catch {
    // Refuse inconsistent ids before a saved event can block replay or job routing.
    return false;
  }
  if (typeof event.data !== 'object' || event.data === null) {
    return false;
  }
  if (event.type === 'conversation.created' && Reflect.get(event.data, 'mode') === 'group') {
    return groupConversationCommandSchema.safeParse(event.data).success;
  }
  if (stream !== 'participation') {
    return true;
  }
  const actorField = event.type === 'participant.added' ? 'addedBy' : 'removedBy';
  const fields = ['conversationId', 'participantId', actorField];
  for (const field of fields) {
    const id: unknown = Reflect.get(event.data, field);
    if (!chatIdSchema.safeParse(id).success) {
      return false;
    }
  }
  return true;
}

function validExpectedSubject(command: AppendCommand, event: EventEnvelope): boolean {
  const expected = command.expectedSubject;
  if (expected === undefined || expected === event.subject) {
    return true;
  }
  const category = `${getEventDefinition(event.type)?.stream}-*`;
  return expected === category;
}

function validCurrentMemoryWrite(event: EventEnvelope): boolean {
  if (event.type !== 'memory.written') {
    return true;
  }
  const identity = memoryWrittenIdentity(event);
  if (identity === null) {
    return false;
  }
  // Refuse an ownership mismatch before it can stop a later replay.
  const scopeFields = [identity.silo, identity.scopeKind, identity.ownerId];
  const hash = createHash('sha256');
  hash.update(JSON.stringify(scopeFields));
  if (identity.scopeId !== hash.digest('hex')) {
    return false;
  }
  const binding = [identity.silo, identity.scopeId, identity.scopeKind, identity.ownerId,
    identity.memoryId, identity.revision];
  const keyHash = createHash('sha256');
  keyHash.update(JSON.stringify(binding));
  const expectedKeyId = `key:${keyHash.digest('hex')}`;
  const written = memoryWrittenEventSchema.parse(event);
  return written.data.keyId === expectedKeyId;
}

function validHistoryCheck(command: AppendCommand): boolean {
  if (command.historyChecked !== undefined && command.historyChecked !== true) return false;
  const deadline = command.deadline;
  if (deadline === undefined) return true;
  return Number.isFinite(deadline) && deadline >= 0;
}

function validMigrationFence(command: AppendCommand, event: EventEnvelope) {
  const sequence = command.expectedGlobalSequence;
  if (sequence === undefined) {
    return true;
  }
  const migration = event.type === 'ownership.seeded' ||
    event.type === 'provider.managed_calls_drain_set';
  return migration && Number.isSafeInteger(sequence) && sequence >= 0;
}

export function sameCommand(a: EventEnvelope, b: EventEnvelope): boolean {
  return (
    a.commandId === b.commandId &&
    a.subject === b.subject &&
    a.principal?.id === b.principal?.id &&
    a.principal?.kind === b.principal?.kind
  );
}
