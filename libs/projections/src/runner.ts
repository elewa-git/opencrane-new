import type { EventEnvelope } from "@opencrane/events";
import type { StoredEvent } from "@opencrane/event-store";
import { runHandler, type Logger } from "@opencrane/observability";
import type { Db, Query } from "./db.ts";

export interface Projection {
  name: string;
  create(db: Query): Promise<void>;
  drop(db: Query): Promise<void>;
  apply(db: Query, event: EventEnvelope, position: number): Promise<void>;
}
export interface EventSource {
  head(): Promise<number>;
  subscribe(
    fromSequence: number,
    signal?: AbortSignal,
  ): AsyncIterable<StoredEvent>;
}

/** One active runner per projection. Handlers must only write through the supplied transaction. */
export class ProjectionRunner {
  private readonly db: Db;
  private readonly source: EventSource;
  private readonly logger: Logger;
  constructor(db: Db, source: EventSource, logger: Logger) {
    this.db = db;
    this.source = source;
    this.logger = logger;
  }

  async initialise(projection: Projection): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.query(`CREATE TABLE IF NOT EXISTS projection_checkpoints (
        name TEXT PRIMARY KEY, sequence BIGINT NOT NULL CHECK (sequence >= 0))`);
      await tx.query(`CREATE TABLE IF NOT EXISTS projection_events (
        projection TEXT NOT NULL, event_id TEXT NOT NULL, PRIMARY KEY (projection, event_id))`);
      await tx.query(
        "INSERT INTO projection_checkpoints VALUES ($1, 0) ON CONFLICT DO NOTHING",
        [projection.name],
      );
      await projection.create(tx);
    });
  }

  async checkpoint(projection: Projection): Promise<number> {
    const result = await this.db.query<{ sequence: string | number }>(
      "SELECT sequence FROM projection_checkpoints WHERE name = $1",
      [projection.name],
    );
    if (!result.rows[0]) {
      throw new Error("Projection is not initialised");
    }
    return Number(result.rows[0].sequence);
  }

  private async apply(
    projection: Projection,
    stored: StoredEvent,
    attempt: number,
  ): Promise<void> {
    const event = stored.event;
    await runHandler(
      this.logger,
      {
        handler: projection.name,
        eventId: event.id,
        eventType: event.type,
        stream: event.subject,
        attempt,
      },
      () =>
        this.db.transaction(async (tx) => {
          const seen = await tx.query(
            "SELECT event_id FROM projection_events WHERE projection = $1 AND event_id = $2",
            [projection.name, event.id],
          );
          if (!seen.rows.length) {
            await projection.apply(tx, event, stored.sequence);
            await tx.query("INSERT INTO projection_events VALUES ($1, $2)", [
              projection.name,
              event.id,
            ]);
          }
          await tx.query(
            "UPDATE projection_checkpoints SET sequence = $2 WHERE name = $1",
            [projection.name, stored.sequence],
          );
        }),
    );
  }

  /** Drain to the head captured on entry. A failure stops immediately; call again with a higher attempt. */
  async run(
    projection: Projection,
    { signal, attempt = 1 }: { signal?: AbortSignal; attempt?: number } = {},
  ): Promise<void> {
    let checkpoint = await this.checkpoint(projection);
    const head = await this.source.head();
    if (checkpoint >= head) {
      return;
    }
    for await (const stored of this.source.subscribe(checkpoint + 1, signal)) {
      signal?.throwIfAborted();
      if (stored.sequence <= checkpoint) {
        continue;
      }
      if (stored.sequence !== checkpoint + 1) {
        throw new Error("Event sequence gap");
      }
      await this.apply(projection, stored, attempt);
      checkpoint = stored.sequence;
      if (checkpoint >= head) {
        return;
      }
    }
    signal?.throwIfAborted();
    throw new Error("Event subscription ended before the captured head");
  }

  /** Stop readers and other runners first. Use a separate projection name/tables for an online rebuild. */
  async rebuild(projection: Projection): Promise<void> {
    await this.db.transaction(async (tx) => {
      await projection.drop(tx);
      await projection.create(tx);
      await tx.query("DELETE FROM projection_events WHERE projection = $1", [
        projection.name,
      ]);
      await tx.query(
        "UPDATE projection_checkpoints SET sequence = 0 WHERE name = $1",
        [projection.name],
      );
    });
    await this.run(projection);
  }
}
