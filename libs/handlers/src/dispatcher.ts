import {
  AckPolicy,
  DeliverPolicy,
  jetstream,
  jetstreamManager,
} from "@nats-io/jetstream";
import type { NatsConnection } from "@nats-io/transport-node";
import { decodeEvent } from "@opencrane/event-store";
import { checkHandlers } from "./registration.ts";
import { HandlerRuntime, retainJob, transactionAdapter } from "./queue.ts";

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

/** Keep one lasting dispatcher per silo; the SQL checkpoint blocks overlapping copies. */
export async function dispatch(
  connection: NatsConnection,
  runtime: HandlerRuntime,
  signal: AbortSignal,
): Promise<void> {
  const { db, silo, handlers } = runtime.options;
  const manifest = checkHandlers(handlers);
  await db.query(`CREATE TABLE IF NOT EXISTS handler_dispatcher (
    id INTEGER PRIMARY KEY CHECK (id = 1), silo TEXT NOT NULL,
    manifest TEXT NOT NULL, sequence BIGINT NOT NULL)`);
  await db.query(
    "INSERT INTO handler_dispatcher VALUES (1, $1, $2, 0) ON CONFLICT DO NOTHING",
    [silo, manifest],
  );
  const consumer = await durableConsumer(connection);
  while (!signal.aborted) {
    const message = await consumer.next({ expires: 1000 });
    if (!message) {
      continue;
    }
    signal.throwIfAborted();
    const event = decodeEvent(message.data, message.subject);
    if (event.silo !== silo) {
      throw new Error("Dispatcher silo mismatch");
    }
    await db.transaction(async (tx) => {
      const state = await tx.query<{
        silo: string;
        manifest: string;
        sequence: string;
      }>(
        "SELECT silo, manifest, sequence FROM handler_dispatcher WHERE id = 1 FOR UPDATE",
      );
      const row = state.rows[0];
      if (!row || row.silo !== silo || row.manifest !== manifest) {
        throw new Error(
          "Dispatcher subscriptions changed; a controlled rebuild is required",
        );
      }
      if (message.seq <= Number(row.sequence)) {
        return;
      }
      if (message.seq !== Number(row.sequence) + 1) {
        throw new Error("Dispatcher event sequence gap");
      }
      for (const handler of handlers) {
        if (handler.eventTypes.includes(event.type)) {
          const id = await runtime.boss.send(handler.name, event, {
            singletonKey: event.subject,
            db: transactionAdapter(tx),
          });
          if (!id) {
            throw new Error("Handler enqueue refused");
          }
          await retainJob(tx, handler.name, id);
        }
      }
      await tx.query(
        "UPDATE handler_dispatcher SET sequence = $1 WHERE id = 1",
        [message.seq],
      );
    });
    // Save every subscriber job and the checkpoint in one database commit.
    // Leave the message unacknowledged if the commit reply is lost or unclear.
    await message.ackAck();
  }
}
