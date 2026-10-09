import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import {
  jetstream,
  jetstreamManager,
  JetStreamApiError,
  type JetStreamClient,
  type JetStreamManager,
  type MsgRequest,
  type StreamConfig,
} from "@nats-io/jetstream";
import {
  connect,
  nkeyAuthenticator,
  TimeoutError,
  RequestError,
  ConnectionError,
  ClosedConnectionError,
  type NatsConnection,
} from "@nats-io/transport-node";
import type { EventEnvelope } from "@opencrane/events";
import {
  decodeEvent,
  sameCommand,
  validateCommand,
  wireSubject,
  type AppendCommand,
  type AppendResult,
  type StoredEvent,
} from "./contract.ts";

function readSubject(subject: string): string {
  const category = /^([a-z]+)-\*$/u.exec(subject);
  return category ? `ev.${category[1]}.*` : wireSubject(subject);
}

const streamName = "EVENTS";
const requestMs = 250;
const readMs = 1_000;
const appendMs = 10_000;
// StreamInfo leaves out some default settings. Treat a missing setting as its default.
const defaults = {
  sealed: false,
  no_ack: false,
  discard_new_per_subject: false,
  allow_rollup_hdrs: false,
  allow_msg_ttl: false,
  allow_msg_counter: false,
  allow_msg_schedules: false,
  allow_atomic: false,
  allow_batched: false,
  mirror_direct: false,
  subject_delete_marker_ttl: 0,
  persist_mode: "default",
} satisfies Partial<StreamConfig>;

function eventsConfig(replicas: number) {
  return {
    name: "EVENTS",
    subjects: ["ev.>"],
    storage: "file",
    retention: "limits",
    num_replicas: replicas,
    max_consumers: -1,
    max_msg_size: -1,
    max_msgs: -1,
    max_msgs_per_subject: -1,
    max_bytes: -1,
    max_age: 0,
    discard: "old",
    duplicate_window: 120_000_000_000,
    deny_delete: true,
    deny_purge: true,
    ...defaults,
  } satisfies Partial<StreamConfig>;
}

// Make this list fail type checking when the SDK adds a configuration field.
type OtherChecks = {
  [Key in Exclude<keyof StreamConfig, keyof ReturnType<typeof eventsConfig>>]-?:
    (config: StreamConfig) => boolean;
};
const otherChecks = {
  mirror: ({ mirror }) => mirror === undefined,
  sources: ({ sources }) => sources === undefined,
  republish: ({ republish }) => republish === undefined,
  subject_transform: ({ subject_transform }) => subject_transform === undefined,
  consumer_limits: ({ consumer_limits }) =>
    (consumer_limits?.inactive_threshold ?? 0) === 0 &&
    (consumer_limits?.max_ack_pending ?? 0) === 0,
  first_seq: ({ first_seq }) =>
    first_seq === undefined || first_seq === 0 || first_seq === 1,
  compression: ({ compression }) =>
    compression === undefined || compression === "none" || compression === "s2",
  allow_direct: () => true,
  description: () => true,
  metadata: () => true,
  placement: () => true,
} satisfies OtherChecks;

function verifyEventsConfig(config: StreamConfig, replicas: number): void {
  for (const [key, expected] of Object.entries(eventsConfig(replicas))) {
    const actual: unknown = Reflect.get(config, key);
    const fallback: unknown = Reflect.get(defaults, key);
    if (JSON.stringify(actual ?? fallback) !== JSON.stringify(expected)) {
      throw new Error(`Incompatible EVENTS configuration: ${key}`);
    }
  }
  for (const [key, accepts] of Object.entries(otherChecks)) {
    if (!accepts(config)) {
      throw new Error(`Incompatible EVENTS configuration: ${key}`);
    }
  }
}

// The SDK does not export JetStreamNotEnabled, so check its name and cause instead.
export function isEventStoreUnavailable(error: unknown): boolean {
  return (
    error instanceof TimeoutError ||
    error instanceof ConnectionError ||
    error instanceof ClosedConnectionError ||
    (error instanceof Error &&
      error.name === "JetStreamNotEnabled" &&
      isEventStoreUnavailable(error.cause)) ||
    (error instanceof RequestError &&
      (error.isNoResponders() || isEventStoreUnavailable(error.cause))) ||
    (error instanceof JetStreamApiError && error.status >= 500)
  );
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
  const manager = await jetstreamManager(connection, { timeout: requestMs });
  return new EventStore(jetstream(connection, { timeout: requestMs }), manager);
}

/** Require TLS before starting the NATS connection. */
export async function connectNats(env: NodeJS.ProcessEnv = process.env) {
  function required(name: string): string {
    const value = env[name]?.trim();
    if (!value) {
      throw new Error(`${name} is required for NATS`);
    }
    return value;
  }
  const servers = required("NATS_URL");
  const address = new URL(servers.includes("://") ? servers : `tls://${servers}`);
  if (address.username || address.password || !["tls:", "nats:"].includes(address.protocol)) {
    throw new Error("NATS_URL must be a NATS address without credentials");
  }
  return connect({
    servers,
    tls: {
      caFile: required("NATS_CA_FILE"),
      certFile: required("NATS_CERT_FILE"),
      keyFile: required("NATS_KEY_FILE"),
      handshakeFirst: true,
      rejectUnauthorized: true,
    },
    authenticator: nkeyAuthenticator(await readFile(required("NATS_NKEY_SEED_FILE"))),
    inboxPrefix: required("NATS_INBOX_PREFIX"),
  });
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
  constructor(client: JetStreamClient, manager: JetStreamManager) {
    this.client = client;
    this.manager = manager;
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
      info = await this.manager.streams.info(streamName);
    } catch (error) {
      if (!(error instanceof JetStreamApiError) || error.code !== 10059) {
        throw error;
      }
      info = await this.manager.streams.add(eventsConfig(replicas));
    }
    verifyEventsConfig(info.config, replicas);
  }

  async append(command: AppendCommand): Promise<AppendResult> {
    const event = validateCommand(command);
    if (!event) {
      return { status: "rejected", reason: "invalid_event" };
    }
    const deadline = Math.min(performance.now() + appendMs, command.deadline ?? Infinity);
    let cause: unknown;
    let backoff = 25;
    while (performance.now() < deadline) {
      try {
        return await this.attempt(event, command.expectedSequence, deadline, command.expectedSubject,
          command.expectedGlobalSequence, command.historyChecked);
      } catch (error) {
        if (!isEventStoreUnavailable(error)) {
          throw new Error("Event append failed", { cause: error });
        }
        cause = error;
        await delay(
          Math.max(0, Math.min(backoff, deadline - performance.now())),
        );
        backoff = Math.min(backoff * 2, 500);
      }
    }
    return { status: "unavailable", cause };
  }

  private async previous(
    event: EventEnvelope,
    deadline: number,
    fromSequence = 1,
  ): Promise<AppendResult | undefined> {
    for await (const stored of this.readStream(event.subject, fromSequence, deadline)) {
      if (sameCommand(stored.event, event)) {
        return { status: "appended", sequence: stored.sequence };
      }
    }
    return undefined;
  }

  private async attempt(
    event: EventEnvelope,
    expectedSequence: number,
    deadline: number,
    expectedSubject?: string,
    expectedGlobalSequence?: number,
    historyChecked?: true,
  ): Promise<AppendResult> {
    if (!historyChecked) {
      const previous = await this.previous(event, deadline);
      if (previous) {
        return previous;
      }
    }
    if (performance.now() >= deadline) {
      throw new TimeoutError();
    }
    const subject = wireSubject(event.subject);
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
      }
      return { status: "appended", sequence: ack.seq };
    } catch (error) {
      if (
        error instanceof JetStreamApiError &&
        [10071, 10164].includes(error.code)
      ) {
        const fromSequence = historyChecked ? expectedSequence + 1 : 1;
        return (await this.previous(event, deadline, fromSequence)) ?? { status: "conflict" };
      }
      throw error;
    }
  }

  /** Read finite entity or category history; fromSequence is an inclusive global position. */
  async *readStream(
    subject: string,
    fromSequence = 1,
    deadline = Infinity,
  ): AsyncGenerator<StoredEvent> {
    const wire = readSubject(subject);
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
      yield {
        sequence: message.seq,
        event: decodeEvent(message.data, message.subject),
      };
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

  private async readHead(deadline = Infinity, signal?: AbortSignal) {
    const manager = this.manager;
    function readGlobalHead() {
      return manager.streams.info(streamName);
    }
    const info = await retryRead(readGlobalHead, deadline, signal);
    return info.state.last_seq;
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
  async head(subject?: string, deadline = Infinity): Promise<number> {
    const manager = this.manager;
    if (subject !== undefined) {
      const wire = readSubject(subject);
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
