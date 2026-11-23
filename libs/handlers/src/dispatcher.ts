import { once } from "node:events";
import {
  AckPolicy,
  DeliverPolicy,
  JetStreamError,
  jetstream,
  jetstreamManager,
  type Consumer,
  type JsMsg,
} from "@nats-io/jetstream";
import { ConnectionError, TimeoutError, type NatsConnection } from "@nats-io/transport-node";
import { decodeEvent, isEventStoreUnavailable, readBeforeDeadline } from "@opencrane/event-store";
import { checkHandlers } from "./registration.ts";
import { HandlerRuntime } from "./queue.ts";
import { subscriptionChanges, type DispatcherState } from "./upgrade.ts";
import { recoverJetStreamOperation,
  type JetStreamRecoveryOptions, type JetStreamRecoveryReporter } from './jetstream-recovery.ts';
import type { Db, Query } from "@opencrane/projections";

const configuration = {
  durable_name: "handler-dispatcher",
  ack_policy: AckPolicy.Explicit,
  deliver_policy: DeliverPolicy.All,
  filter_subject: "ev.>",
  max_ack_pending: 1,
  ack_wait: 5_000_000_000,
  max_deliver: -1,
};

/** Use this only during setup; running dispatchers cannot manage consumers. */
export async function provisionDispatcher(connection: NatsConnection) {
  const manager = await jetstreamManager(connection);
  await manager.consumers.add("EVENTS", configuration);
}

async function durableConsumer(connection: NatsConnection) {
  const manager = await jetstreamManager(connection);
  const info = await manager.consumers.info("EVENTS", configuration.durable_name);
  for (const [key, value] of Object.entries(configuration)) {
    if (Reflect.get(info.config, key) !== value) {
      throw new Error(`Incompatible dispatcher consumer: ${key}`);
    }
  }
  if (info.config.deliver_subject || info.config.filter_subjects?.length) {
    throw new Error("Incompatible dispatcher delivery or filters");
  }
  return jetstream(connection).consumers.get(
    "EVENTS",
    configuration.durable_name,
  );
}

export type DispatchHooks = {
  ready?: () => Promise<void>;
  failed?: () => void;
  reportRecovery?: JetStreamRecoveryReporter;
};

/** Keep one lasting dispatcher per silo; the SQL checkpoint blocks overlapping copies. */
export async function dispatch(
  connection: NatsConnection,
  runtime: HandlerRuntime,
  signal: AbortSignal,
  hooks: DispatchHooks = {},
): Promise<void> {
  const db = runtime.options.db;
  if (!db.lock) {
    throw new Error("Dispatcher requires a database lock");
  }
  async function run(locked: Db) {
    try {
      // Use the connection already reserved for dispatch, even while workers fill the pool.
      await dispatchLocked(connection, runtime, locked, signal, hooks);
    } catch (error) {
      // Tell the worker before the database starts its lock cleanup.
      hooks.failed?.();
      throw error;
    }
  }
  await db.lock("handler-dispatcher", run);
}

/** Prepare fresh subscriptions or report the required upgrade without changing saved work.
 * Call while holding the handler-dispatcher database lock and before starting event writers.
 */
export async function prepareDispatcher(runtime: HandlerRuntime,
  db: Db = runtime.options.db): Promise<boolean> {
  const { silo, handlers } = runtime.options;
  const manifest = checkHandlers(handlers);
  await db.query(`CREATE TABLE IF NOT EXISTS handler_dispatcher (
    id INTEGER PRIMARY KEY CHECK (id = 1), silo TEXT NOT NULL,
    manifest TEXT NOT NULL, sequence BIGINT NOT NULL)`);
  await db.query(
    "INSERT INTO handler_dispatcher VALUES (1, $1, $2, 0) ON CONFLICT DO NOTHING",
    [silo, manifest],
  );
  const state = await db.query<DispatcherState>(
    "SELECT silo, manifest, sequence FROM handler_dispatcher WHERE id = 1",
  );
  const row = state.rows[0];
  if (!row || row.silo !== silo) {
    throw new Error("Dispatcher silo mismatch");
  }
  if (row.manifest !== manifest) {
    const changes = subscriptionChanges(row.manifest, manifest);
    if (!changes.length) {
      runtime.options.logger.info({}, 'Only subscription order changed');
    }
    const command = "npm run ops -- upgrade-handlers --dry-run";
    const fields = { changes };
    const message =
      `Dispatcher subscriptions changed. Run ${command} first. Stop clients and event writers, ` +
      'drain unfinished jobs with the old workers, then stop workers and database clients. ' +
      'Run npm run ops -- upgrade-handlers --confirm-writers-stopped and restart services. ' +
      'Computers are not suspended while the dispatcher waits';
    runtime.options.logger.error(fields, message);
    return false;
  }
  return true;
}

async function dispatchLocked(
  connection: NatsConnection,
  runtime: HandlerRuntime,
  db: Db,
  signal: AbortSignal,
  hooks: DispatchHooks,
): Promise<void> {
  const manifest = checkHandlers(runtime.options.handlers);
  if (!await prepareDispatcher(runtime, db)) {
    if (!signal.aborted) {
      await once(signal, "abort");
    }
    return;
  }
  const consumer = await durableConsumer(connection);
  const pulls = dispatcherPulls(connection, consumer, signal);
  const sharedRecovery = { signal, logger: runtime.options.logger, report: hooks.reportRecovery,
    isUnavailable: isPullUnavailable };
  const pullRecovery: JetStreamRecoveryOptions = {
    ...sharedRecovery, operation: 'Dispatcher pull',
  };
  const ackRecovery: JetStreamRecoveryOptions = {
    ...sharedRecovery, operation: 'Dispatcher acknowledgement',
  };
  try {
    await hooks.ready?.();
    let waiting: JsMsg | null = null;
    while (!signal.aborted) {
      const message = waiting ?? await recoverJetStreamOperation(pulls.next, pullRecovery);
      if (!message) continue;
      signal.throwIfAborted();
      // Leave the delivery unacknowledged if the database commit reply is unclear.
      await commitMessage(runtime, db, manifest, message);
      waiting = await acknowledgeMessage(message, consumer, pulls.next, ackRecovery);
    }
  } finally {
    await pulls.close();
  }
}

const pullExpiryMs = 1000;
// Allow the installed client's two-second reconnect delay and its TLS jitter.
const reconnectWaitMs = 3000;

function isPullUnavailable(error: unknown) {
  if (isEventStoreUnavailable(error)) return true;
  if (!(error instanceof JetStreamError)) return false;
  // The SDK closes the pull after two missed heartbeats.
  if (error.message === 'heartbeats missed') return true;
  if (!('code' in error)) return false;
  return error.code === 503 || (error.code === 409 && error.message === 'server shutdown');
}

async function requireConnection(connection: NatsConnection) {
  if (connection.isClosed()) {
    throw new Error('Dispatcher NATS connection closed', { cause: await connection.closed() });
  }
}

type ConnectionStatuses = ReturnType<NatsConnection['status']>;

function canStop(statuses: ConnectionStatuses): statuses is ConnectionStatuses & { stop(): void } {
  return 'stop' in statuses && typeof statuses.stop === 'function';
}

function dispatcherPulls(connection: NatsConnection, consumer: Consumer, signal: AbortSignal) {
  const statuses = connection.status();
  // The SDK returns a queued iterator. Stop it even if the caller keeps the connection open.
  if (!canStop(statuses)) throw new Error('Dispatcher cannot close the NATS status listener');
  const stopStatuses = statuses.stop.bind(statuses);
  let connected = new AbortController();
  let reconnecting: PromiseWithResolvers<void> | undefined;
  async function trackConnection() {
    try {
      for await (const status of statuses) {
        if (status.type === 'disconnect' || status.type === 'reconnect') {
          // Close a fetch before the SDK can reuse its inbox after a reconnect.
          connected.abort(new ConnectionError('Dispatcher pull interrupted by a connection change'));
        }
        if (status.type === 'disconnect') {
          reconnecting ??= Promise.withResolvers<void>();
        }
        if (status.type === 'reconnect') {
          connected = new AbortController();
          reconnecting?.resolve();
          reconnecting = undefined;
        }
      }
    } finally {
      reconnecting?.resolve();
    }
  }
  const tracking = trackConnection();
  function waitForReconnect() {
    return reconnecting?.promise ?? Promise.resolve();
  }
  async function next() {
    await requireConnection(connection);
    if (signal.aborted) return null;
    if (reconnecting) {
      const deadline = performance.now() + reconnectWaitMs;
      await readBeforeDeadline(waitForReconnect, deadline, signal);
      await requireConnection(connection);
    }
    if (signal.aborted) return null;
    const connectionSignal = connected.signal;
    connectionSignal.throwIfAborted();
    const message = await fetchMessage(consumer, signal, connectionSignal);
    if (!message && !signal.aborted) await requireConnection(connection);
    return message;
  }
  async function close() {
    stopStatuses();
    await tracking;
  }
  return { next, close };
}

async function fetchMessage(consumer: Consumer, signal: AbortSignal, connectionSignal: AbortSignal) {
  const cancel = AbortSignal.any([signal, connectionSignal]);
  const messages = await consumer.fetch({ max_messages: 1, expires: pullExpiryMs, bind: true });
  function closePull() {
    void messages.close();
  }
  cancel.addEventListener('abort', closePull, { once: true });
  try {
    if (cancel.aborted) closePull();
    for await (const message of messages) {
      if (signal.aborted) return null;
      connectionSignal.throwIfAborted();
      return message;
    }
    if (!signal.aborted) connectionSignal.throwIfAborted();
    return null;
  } finally {
    cancel.removeEventListener('abort', closePull);
    await messages.close();
  }
}

async function acknowledgeMessage(message: JsMsg, consumer: Consumer,
  pull: () => Promise<JsMsg | null>, recovery: JetStreamRecoveryOptions) {
  let firstDelivery: JsMsg | null = message;
  async function confirm() {
    // ackAck can only be called once per delivery. After a lost reply, pull from
    // the same durable to find out whether it will redeliver the committed event.
    const delivery = firstDelivery ?? await pull();
    firstDelivery = null;
    if (!delivery) {
      recovery.signal.throwIfAborted();
      const info = await consumer.info();
      if (info.ack_floor.stream_seq >= message.seq) return null;
      throw new TimeoutError();
    }
    // With one unacknowledged delivery allowed, later delivery confirms progress.
    if (delivery.seq > message.seq) return delivery;
    if (delivery.seq < message.seq) {
      throw new Error('Dispatcher received an earlier delivery during acknowledgement recovery');
    }
    if (!await delivery.ackAck()) throw new Error('Dispatcher acknowledgement was not sent');
    return null;
  }
  return recoverJetStreamOperation(confirm, recovery);
}

async function commitMessage(runtime: HandlerRuntime, db: Db, manifest: string, message: JsMsg) {
  const { silo, handlers } = runtime.options;
  const event = decodeEvent(message.data, message.subject);
  if (event.silo !== silo) {
    throw new Error("Dispatcher silo mismatch");
  }
  async function enqueueAndSaveCheckpoint(tx: Query) {
    const state = await tx.query<DispatcherState>(
      "SELECT silo, manifest, sequence FROM handler_dispatcher WHERE id = 1 FOR UPDATE",
    );
    const row = state.rows[0];
    if (!row || row.silo !== silo || row.manifest !== manifest) {
      throw new Error("Dispatcher state changed during dispatch");
    }
    const checkpoint = Number(row.sequence);
    if (message.seq <= checkpoint) {
      return;
    }
    if (message.seq !== checkpoint + 1) {
      throw new Error("Dispatcher event sequence gap");
    }
    for (const handler of handlers) {
      if (handler.eventTypes.includes(event.type)) {
        await runtime.enqueue(handler, event, tx);
      }
    }
    await tx.query(
      "UPDATE handler_dispatcher SET sequence = $1 WHERE id = 1",
      [message.seq],
    );
  }
  // Save every subscriber job and the checkpoint in one database commit.
  await db.transaction(enqueueAndSaveCheckpoint);
}
