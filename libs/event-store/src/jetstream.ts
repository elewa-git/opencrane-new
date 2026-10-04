import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import {
  jetstream,
  jetstreamManager,
  JetStreamApiError,
  type JetStreamClient,
  type JetStreamManager,
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
const appendMs = 10_000;
// The server omits some defaults from StreamInfo. Absence means these values.
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

// Require a decision here when the SDK adds a configuration field.
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

// JetStreamNotEnabled is not in the SDK public exports; check its name and typed cause.
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

/** The caller owns the authenticated TLS connection and its lifecycle. */
export async function createEventStore(connection: NatsConnection) {
  const manager = await jetstreamManager(connection, { timeout: requestMs });
  return new EventStore(jetstream(connection, { timeout: requestMs }), manager);
}

/** TLS is mandatory, including before the NATS protocol handshake. */
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

/** Process entrypoints use this adapter; the EVENTS stream is provisioned separately. */
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
    const deadline = performance.now() + appendMs;
    let cause: unknown;
    let backoff = 25;
    while (performance.now() < deadline) {
      try {
        return await this.attempt(event, command.expectedSequence, deadline);
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
  ): Promise<AppendResult | undefined> {
    for await (const stored of this.readStream(event.subject, 1, deadline)) {
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
  ): Promise<AppendResult> {
    const previous = await this.previous(event, deadline);
    if (previous) {
      return previous;
    }
    if (performance.now() >= deadline) {
      throw new TimeoutError();
    }
    const subject = wireSubject(event.subject);
    try {
      const ack = await this.client.publish(subject, JSON.stringify(event), {
        msgID: event.id,
        expect: { streamName, lastSubjectSequence: expectedSequence },
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
        return (await this.previous(event, deadline)) ?? { status: "conflict" };
      }
      throw error;
    }
  }

  /** Finite entity/category history (for example team-*); fromSequence is inclusive and global. */
  async *readStream(
    subject: string,
    fromSequence = 1,
    deadline = Infinity,
  ): AsyncGenerator<StoredEvent> {
    const wire = readSubject(subject);
    const head = (await this.manager.streams.info(streamName)).state.last_seq;
    let sequence = Math.max(1, fromSequence);
    while (sequence <= head) {
      if (performance.now() >= deadline) {
        throw new TimeoutError();
      }
      // The server supports next_by_subj on MSG.GET; the SDK types omit it.
      const query = { next_by_subj: wire, seq: sequence };
      const message = await this.manager.streams.getMessage(streamName, query);
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

  /** Read from the caller's SQL checkpoint; no server-side delivery cursor survives a restart. */
  async *subscribe(
    fromSequence = 1,
    signal?: AbortSignal,
  ): AsyncGenerator<StoredEvent> {
    signal?.throwIfAborted();
    let sequence = Math.max(1, fromSequence);
    let head = 0;
    while (!signal?.aborted) {
      if (sequence > head) head = await this.head();
      if (sequence > head) {
        // Poll only at the live tail. Historical reads have no delay or shared cursor.
        await delay(100);
        continue;
      }
      // Bound read-ahead and keep log order even when replies arrive out of order.
      const messages = await Promise.all(Array.from({ length: Math.min(64, head - sequence + 1) },
        (_, offset) => this.manager.streams.getMessage(streamName, { seq: sequence + offset })));
      for (const message of messages) {
        if (signal?.aborted) return;
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
  }

  /** Latest global sequence, or latest entity/category sequence (for example team-*). */
  async head(subject?: string): Promise<number> {
    if (subject !== undefined) {
      const wire = readSubject(subject);
      return (await this.manager.streams.getMessage(streamName, { last_by_subj: wire }))?.seq ?? 0;
    }
    return (await this.manager.streams.info(streamName)).state.last_seq;
  }
}
