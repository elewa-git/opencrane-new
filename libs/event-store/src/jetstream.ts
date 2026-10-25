import { eventsConfig, verifyEventsConfig } from "./stream-config.ts";
import { connectNats, isEventStoreUnavailable } from "./nats-connection.ts";
import { setTimeout as delay } from "node:timers/promises";
import {
  jetstream,
  jetstreamManager,
  JetStreamApiError,
  type JetStreamClient,
  type JetStreamManager,
  type MsgRequest,
} from "@nats-io/jetstream";
import {
  TimeoutError,
  type NatsConnection,
} from "@nats-io/transport-node";
import type { EventEnvelope } from "@opencrane/events";
import {
  decodeEvent,
  matchesConversationRead,
  sameCommand,
  validateCommand,
  wireSubject,
  type AppendCommand,
  type AppendResult,
  type AppendOutcome,
  type StoredEvent,
} from "./contract.ts";

function readSubject(subject: string): string {
  const category = /^(chat-state|[a-z]+)-\*$/u.exec(subject);
  return category ? `ev.${category[1]}.*` : wireSubject(subject);
}

function conversationReadSubject(subject: string, includeConversationCloses: boolean): string {
  const wire = readSubject(subject);
  if (!includeConversationCloses) return wire;
  if (!subject.startsWith('conversation-') || subject.endsWith('-*')) {
    throw new Error('Closing activity requires one conversation');
  }
  const conversationId = subject.slice('conversation-'.length);
  // Use one indexed query for both close formats. Filter other categories before returning rows.
  return `ev.*.${conversationId}`;
}

const streamName = "EVENTS";
const requestMs = 250;
const readMs = 1_000;
const appendMs = 10_000;

function unavailableAppend(cause: unknown, mayHavePublished: boolean): AppendOutcome {
  return { status: 'transport_failure', cause, mayHavePublished };
}

// Keep the existing command API while ownership-sensitive callers use the detailed result.
function commandResult(outcome: AppendOutcome): AppendResult {
  switch (outcome.status) {
    case 'appended':
    case 'duplicate_saved':
      return { status: 'appended', sequence: outcome.sequence };
    case 'conditional_rejection_changed':
    case 'conditional_rejection_unchanged':
      return { status: 'conflict' };
    case 'conditional_rejection_unknown':
    case 'transport_failure':
      if (outcome.mayHavePublished) {
        return { status: 'unavailable', cause: outcome.cause };
      }
      return { status: 'unavailable', cause: outcome.cause, notPublished: true };
    case 'rejected':
      return outcome;
  }
}

// Retry temporary failures for at most one second, or until the caller's earlier deadline.
async function retryRead<Value>(read: () => Promise<Value>, callerDeadline = Infinity,
  signal?: AbortSignal) {
  const deadline = Math.min(callerDeadline, performance.now() + readMs);
  let cause: unknown = new TimeoutError();
  let backoff = 25;
  while (performance.now() < deadline) {
    signal?.throwIfAborted();
    try {
      return await readBeforeDeadline(read, deadline, signal);
    } catch (error) {
      if (!isEventStoreUnavailable(error)) {
        throw error;
      }
      cause = error;
      const remaining = deadline - performance.now();
      if (remaining <= 0) {
        break;
      }
      const options = signal ? { signal } : undefined;
      // Jitter retry times so many reads do not all retry together during an outage.
      const jitteredBackoff = backoff / 2 + Math.random() * backoff / 2;
      await delay(Math.min(jitteredBackoff, remaining), undefined, options);
      backoff = Math.min(backoff * 2, 500);
    }
  }
  throw cause;
}

export async function readBeforeDeadline<Value>(read: () => Promise<Value>, deadline: number,
  signal?: AbortSignal) {
  const expired = Promise.withResolvers<never>();
  function timeout() {
    expired.reject(new TimeoutError());
  }
  function abort() {
    const reason: unknown = signal?.reason;
    if (reason instanceof Error) {
      expired.reject(reason);
      return;
    }
    expired.reject(new Error("Event read aborted"));
  }
  const timer = setTimeout(timeout, Math.max(0, deadline - performance.now()));
  const listenerOptions = { once: true };
  signal?.addEventListener("abort", abort, listenerOptions);
  try {
    // Keep the SDK's 250 ms timeout. The outer limit also stops its last pending read.
    const pendingRead = read();
    const value = await Promise.race([pendingRead, expired.promise]);
    // A stalled event loop can deliver a reply before it runs an expired timer.
    if (performance.now() >= deadline) {
      throw new TimeoutError();
    }
    return value;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

/** The caller opens and closes this authenticated TLS connection. */
export async function createEventStore(connection: NatsConnection) {
  // Use the SDK's normal management timeout when provisioning; keep event reads short.
  const provisioningManager = await jetstreamManager(connection);
  const manager = await jetstreamManager(connection, { timeout: requestMs, checkAPI: false });
  const client = jetstream(connection, { timeout: requestMs });
  return new EventStore(client, manager, provisioningManager);
}

/** Processes use this adapter; operators create the EVENTS stream separately. */
export async function connectEventStore(env: NodeJS.ProcessEnv = process.env) {
  const connection = await connectNats(env);
  try {
    const store = await createEventStore(connection);
    return { store, close: () => connection.close() };
  } catch (error) {
    await connection.close();
    throw error;
  }
}

export class EventStore {
  private readonly client: JetStreamClient;
  private readonly manager: JetStreamManager;
  private readonly provisioningManager: JetStreamManager;
  constructor(
    client: JetStreamClient,
    manager: JetStreamManager,
    provisioningManager: JetStreamManager = manager,
  ) {
    this.client = client;
    this.manager = manager;
    this.provisioningManager = provisioningManager;
  }

  /** Refuse an incompatible existing stream without changing its configuration. */
  async ensureStream({
    replicas = 3,
  }: { replicas?: number } = {}): Promise<void> {
    if (![1, 3, 5].includes(replicas)) {
      throw new Error("Invalid replica count");
    }
    let info;
    try {
      info = await this.provisioningManager.streams.info(streamName);
    } catch (error) {
      if (!(error instanceof JetStreamApiError) || error.code !== 10059) {
        throw error;
      }
      info = await this.provisioningManager.streams.add(eventsConfig(replicas));
    }
    verifyEventsConfig(info.config, replicas);
  }

  async append(command: AppendCommand): Promise<AppendResult> {
    const outcome = await this.appendOutcome(command);
    return commandResult(outcome);
  }

  async appendOutcome(command: AppendCommand): Promise<AppendOutcome> {
    const event = validateCommand(command);
    if (!event) {
      return { status: "rejected", reason: "invalid_event" };
    }
    const deadline = Math.min(performance.now() + appendMs, command.deadline ?? Infinity);
    // Keep uncertainty across retries once any publish could have reached NATS.
    const publication = { mayHavePublished: false };
    let cause: unknown;
    let backoff = 25;
    while (performance.now() < deadline) {
      if (command.signal?.aborted) {
        return unavailableAppend(command.signal.reason, publication.mayHavePublished);
      }
      try {
        return await this.attempt(event, command.expectedSequence, deadline, publication,
          command.expectedSubject,
          command.expectedGlobalSequence, command.historyChecked, command.signal, command.checkAccess);
      } catch (error) {
        if (command.signal?.aborted) {
          return unavailableAppend(command.signal.reason, publication.mayHavePublished);
        }
        if (!isEventStoreUnavailable(error)) {
          throw new Error("Event append failed", { cause: error });
        }
        cause = error;
        const options = command.signal ? { signal: command.signal } : undefined;
        try {
          const remaining = deadline - performance.now();
          const waitMs = Math.max(0, Math.min(backoff, remaining));
          await delay(Math.ceil(waitMs), undefined, options);
          // Stop after the final wait even if its timer wakes a fraction early.
          if (remaining <= backoff) {
            break;
          }
        } catch (error) {
          if (!command.signal?.aborted) {
            throw error;
          }
          return unavailableAppend(command.signal.reason, publication.mayHavePublished);
        }
        backoff = Math.min(backoff * 2, 500);
      }
    }
    return unavailableAppend(cause, publication.mayHavePublished);
  }

  private async previous(
    event: EventEnvelope,
    deadline: number,
    fromSequence = 1,
  ): Promise<AppendOutcome | undefined> {
    for await (const stored of this.readStream(event.subject, fromSequence, deadline)) {
      if (sameCommand(stored.event, event)) {
        return { status: "duplicate_saved", sequence: stored.sequence };
      }
    }
    return undefined;
  }

  private async attempt(
    event: EventEnvelope,
    expectedSequence: number,
    deadline: number,
    publication: { mayHavePublished: boolean },
    expectedSubject?: string,
    expectedGlobalSequence?: number,
    historyChecked?: true,
    signal?: AbortSignal,
    checkAccess?: () => Promise<unknown>,
  ): Promise<AppendOutcome> {
    if (!historyChecked) {
      const previous = await this.previous(event, deadline);
      if (previous) {
        return previous;
      }
    }
    if (performance.now() >= deadline) {
      throw new TimeoutError();
    }
    if (event.type === 'conversation.created') {
      // Keep creation as the first event so a new audience always adds a new subject.
      if (expectedSubject === 'conversation-*') {
        const existing = await this.head(event.subject, deadline);
        if (existing !== 0) {
          return await this.previousCreation(event, deadline) ?? { status: 'conditional_rejection_changed' };
        }
      } else if (expectedSequence !== 0) {
        return { status: 'conditional_rejection_changed' };
      }
    }
    if (checkAccess) {
      // Bind the access check to the publish. A saved change in between refuses the append.
      expectedGlobalSequence ??= await this.head(undefined, deadline);
      try {
        await checkAccess();
      } catch (cause) {
        // Keep an earlier publish with a lost reply uncertain until the caller reconciles it.
        return unavailableAppend(cause, publication.mayHavePublished);
      }
    }
    // Recheck after awaited reads, immediately before starting a new publish.
    signal?.throwIfAborted();
    if (performance.now() >= deadline) {
      throw new TimeoutError();
    }
    return this.publishConditional(event, expectedSequence, deadline, publication, expectedSubject,
      expectedGlobalSequence, historyChecked);
  }

  private async publishConditional(
    event: EventEnvelope,
    expectedSequence: number,
    deadline: number,
    publication: { mayHavePublished: boolean },
    expectedSubject?: string,
    expectedGlobalSequence?: number,
    historyChecked?: true,
  ): Promise<AppendOutcome> {
    const subject = wireSubject(event.subject);
    const earlierUncertainty = publication.mayHavePublished;
    publication.mayHavePublished = true;
    try {
      const ack = await this.client.publish(subject, JSON.stringify(event), {
        msgID: event.id,
        expect: { streamName, lastSubjectSequence: expectedSequence,
          ...(expectedGlobalSequence !== undefined ? { lastSequence: expectedGlobalSequence } : {}),
          ...(expectedSubject ? { lastSubjectSequenceSubject: readSubject(expectedSubject) } : {}) },
        timeout: Math.min(requestMs, deadline - performance.now()),
        retries: 1,
      });
      if (ack.duplicate) {
        const stored = await this.manager.streams.getMessage(streamName, {
          seq: ack.seq,
        });
        if (
          !stored ||
          stored.subject !== subject ||
          !sameCommand(decodeEvent(stored.data, subject), event)
        ) {
          return { status: "rejected", reason: "duplicate_id" };
        }
        return { status: 'duplicate_saved', sequence: ack.seq };
      }
      return { status: "appended", sequence: ack.seq };
    } catch (error) {
      if (
        error instanceof JetStreamApiError &&
        [10071, 10164].includes(error.code)
      ) {
        // Keep an earlier lost reply uncertain, but this rejected publish saved nothing.
        publication.mayHavePublished = earlierUncertainty;
        return this.recoverConditional(event, expectedSequence, deadline, publication,
          expectedSubject, historyChecked);
      }
      throw error;
    }
  }

  private async recoverConditional(event: EventEnvelope, expectedSequence: number,
    deadline: number, publication: { mayHavePublished: boolean },
    expectedSubject?: string, historyChecked?: true): Promise<AppendOutcome> {
    const fromSequence = historyChecked ? expectedSequence + 1 : 1;
    let position = expectedSequence;
    try {
      for await (const stored of this.readStream(event.subject, fromSequence, deadline)) {
        if (sameCommand(stored.event, event)) {
          return { status: 'duplicate_saved', sequence: stored.sequence };
        }
        position = Math.max(position, stored.sequence);
      }
      if (expectedSubject && expectedSubject !== event.subject) {
        position = await this.head(expectedSubject, deadline);
      }
      if (position !== expectedSequence) {
        return { status: 'conditional_rejection_changed' };
      }
      return { status: 'conditional_rejection_unchanged' };
    } catch (cause) {
      // End this request. A failed recovery read cannot establish a changed subject.
      return { status: 'conditional_rejection_unknown', cause,
        mayHavePublished: publication.mayHavePublished };
    }
  }

  private async previousCreation(event: EventEnvelope, deadline: number) {
    // Check one event for a lost creation reply, even when the category has moved.
    for await (const stored of this.readStream(event.subject, 1, deadline)) {
      if (sameCommand(stored.event, event)) {
        return { status: 'duplicate_saved' as const, sequence: stored.sequence };
      }
      break;
    }
    return undefined;
  }

  /** Read one saved event at its global position without scanning its neighbours. */
  async readEvent(sequence: number, deadline = Infinity): Promise<StoredEvent> {
    const message = await this.readMessage({ seq: sequence }, deadline);
    if (!message || message.seq !== sequence) throw new Error("Event position missing");
    return { sequence: message.seq, event: decodeEvent(message.data, message.subject) };
  }

  /** Read finite entity or category history; fromSequence is an inclusive global position. */
  async *readStream(
    subject: string,
    fromSequence = 1,
    deadline = Infinity,
    includeConversationCloses = false,
  ): AsyncGenerator<StoredEvent> {
    const wire = conversationReadSubject(subject, includeConversationCloses);
    const head = await this.readHead(deadline);
    let sequence = Math.max(1, fromSequence);
    while (sequence <= head) {
      if (performance.now() >= deadline) {
        throw new TimeoutError();
      }
      // NATS accepts next_by_subj for MSG.GET, though the SDK types omit it.
      const query = { next_by_subj: wire, seq: sequence };
      const message = await this.readMessage(query, deadline);
      if (!message || message.seq > head) {
        break;
      }
      const event = decodeEvent(message.data, message.subject);
      if (!includeConversationCloses || matchesConversationRead(event, subject)) {
        yield { sequence: message.seq, event };
      }
      sequence = message.seq + 1;
    }
  }

  private readMessage(query: MsgRequest, deadline = Infinity, signal?: AbortSignal) {
    const manager = this.manager;
    function read() {
      return manager.streams.getMessage(streamName, query);
    }
    return retryRead(read, deadline, signal);
  }

  private readInfo(deadline = Infinity, signal?: AbortSignal) {
    const manager = this.manager;
    function readStreamInfo() {
      return manager.streams.info(streamName);
    }
    return retryRead(readStreamInfo, deadline, signal);
  }

  private async readHead(deadline = Infinity, signal?: AbortSignal) {
    const info = await this.readInfo(deadline, signal);
    return info.state.last_seq;
  }

  /** Read the number of saved subjects without listing subjects or reading events. */
  async subjectCount(deadline = Infinity): Promise<number> {
    const info = await this.readInfo(deadline);
    const count = info.state.num_subjects ?? 0;
    if (!Number.isSafeInteger(count) || count < 0 ||
        (info.state.messages > 0 && count === 0)) {
      throw new Error('Event subject count unavailable');
    }
    return count;
  }

  /** Read from the caller's SQL checkpoint; NATS does not keep a cursor across restarts. */
  async *subscribe(
    fromSequence = 1,
    signal?: AbortSignal,
  ): AsyncGenerator<StoredEvent> {
    signal?.throwIfAborted();
    let sequence = Math.max(1, fromSequence);
    let head = 0;
    try {
      while (!signal?.aborted) {
        if (sequence > head) {
          head = await this.readHead(Infinity, signal);
        }
        if (sequence > head) {
          // Wait only at the live end. Earlier reads have no delay or shared cursor.
          await delay(100);
          continue;
        }
        // Limit how far reads run ahead and keep event order if replies arrive out of order.
        const count = Math.min(64, head - sequence + 1);
        const messages = await this.readBatch(sequence, count, signal);
        for (const message of messages) {
          if (signal?.aborted) {
            return;
          }
          if (!message) {
            throw new Error("Event sequence gap");
          }
          yield {
            sequence: message.seq,
            event: decodeEvent(message.data, message.subject),
          };
          sequence = message.seq + 1;
        }
      }
    } catch (error) {
      if (!signal?.aborted) {
        throw error;
      }
    }
  }

  private async readBatch(sequence: number, count: number, signal?: AbortSignal) {
    const controller = new AbortController();
    const batchSignal = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal;
    const readMessage = this.readMessage.bind(this);
    function readSequence(_value: unknown, offset: number) {
      const query = { seq: sequence + offset };
      return readMessage(query, Infinity, batchSignal);
    }
    const batchLength = { length: count };
    const reads = Array.from(batchLength, readSequence);
    try {
      return await Promise.all(reads);
    } finally {
      // Stop sibling reads after a batch fails; none of their results can be used.
      controller.abort();
    }
  }

  /** Return the latest global position, or latest position for an entity or category. */
  async head(subject?: string, deadline = Infinity,
    includeConversationCloses = false): Promise<number> {
    const manager = this.manager;
    if (subject !== undefined) {
      const wire = conversationReadSubject(subject, includeConversationCloses);
      const query = { last_by_subj: wire };
      function readSubjectHead() {
        return manager.streams.getMessage(streamName, query);
      }
      const message = await retryRead(readSubjectHead, deadline);
      return message?.seq ?? 0;
    }
    return this.readHead(deadline);
  }
}
