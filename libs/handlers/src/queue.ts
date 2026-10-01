import { PgBoss, type Queue, type JobWithMetadata } from "pg-boss";
import { parseEventByType } from "@opencrane/events";
import { runHandler, type Logger } from "@opencrane/observability";
import type { Db, Query } from "@opencrane/projections";
import { withinAttempt } from "./attempt.ts";
import { checkHandlers, type Handler } from "./registration.ts";

export function transactionAdapter(tx: Query) {
  return {
    executeSql: (sql: string, values?: unknown[]) => tx.query(sql, values),
  };
}

// pg-boss 12.35 has no infinite queued-job retention option. This pinned
// adapter sets infinity before commit; failed heads also disable deletion.
export async function retainJob(
  tx: Query,
  name: string,
  id: string,
): Promise<void> {
  await tx.query(
    "UPDATE pgboss.job SET keep_until = 'infinity' WHERE name = $1 AND id = $2",
    [name, id],
  );
}

export interface RuntimeOptions {
  db: Db;
  logger: Logger;
  silo: string;
  handlers: readonly Handler[];
  retryLimit?: number;
  retryDelay?: number;
  expireInSeconds?: number;
}

/** Owns a dedicated pg-boss schema in the supplied silo database. */
export class HandlerRuntime {
  readonly boss: PgBoss;
  readonly options: RuntimeOptions;
  constructor(options: RuntimeOptions) {
    checkHandlers(options.handlers);
    this.options = options;
    this.boss = new PgBoss({
      db: transactionAdapter(options.db),
      schedule: false,
    });
    this.boss.on("error", (err) =>
      options.logger.error({ err }, "handler.queue_failed"),
    );
  }

  async start(): Promise<void> {
    await this.boss.start();
    await this.options.db.query(`CREATE TABLE IF NOT EXISTS handler_receipts (
      handler TEXT NOT NULL, event_id TEXT NOT NULL, PRIMARY KEY (handler, event_id))`);
    for (const handler of this.options.handlers) {
      await this.ensureQueue(`${handler.name}-dead`, {
        policy: "standard",
        deleteAfterSeconds: 0,
      });
      await this.ensureQueue(handler.name, {
        policy: "key_strict_fifo",
        deadLetter: `${handler.name}-dead`,
        deleteAfterSeconds: 0,
        retryLimit: this.options.retryLimit ?? 5,
        retryDelay: this.options.retryDelay ?? 1,
        retryBackoff: true,
        expireInSeconds: this.options.expireInSeconds ?? 60,
      });
    }
  }

  private async ensureQueue(
    name: string,
    options: Omit<Queue, "name">,
  ): Promise<void> {
    await this.boss.createQueue(name, options);
    const queue = await this.boss.getQueue(name);
    for (const [key, value] of Object.entries(options)) {
      if (!queue || Reflect.get(queue, key) !== value) {
        throw new Error(`Incompatible handler queue: ${name}/${key}`);
      }
    }
  }

  async work(concurrency = 4): Promise<void> {
    for (const handler of this.options.handlers) {
      const workOptions = {
        includeMetadata: true,
        batchSize: 1,
        localConcurrency: concurrency,
        pollingIntervalSeconds: 0.5,
      } as const;
      await this.boss.work<unknown, void, typeof workOptions>(
        handler.name,
        workOptions,
        async (jobs) => {
          const job = jobs[0];
          if (job) {
            await this.apply(handler, job);
          }
        },
      );
    }
  }

  private async apply(
    handler: Handler,
    job: JobWithMetadata<unknown>,
  ): Promise<void> {
    const parsed = parseEventByType(job.data);
    if (
      !parsed.success ||
      parsed.event.silo !== this.options.silo ||
      !handler.eventTypes.includes(parsed.event.type) ||
      parsed.event.subject !== job.singletonKey
    ) {
      throw new Error("Invalid handler job");
    }
    const event = parsed.event;
    await runHandler(
      this.options.logger,
      {
        handler: handler.name,
        eventId: event.id,
        eventType: event.type,
        stream: event.subject,
        attempt: job.retryCount + 1,
      },
      () =>
        this.options.db.transaction((transaction) =>
          withinAttempt(
            transaction,
            job.signal,
            job.expireInSeconds,
            async (tx) => {
              // Hold the fetched attempt through commit. Expiry/replay cannot start a
              // second SQL writer while this transaction is still running.
              const claim = await tx.query<{
                state: string;
                retry_count: number;
              }>(
                "SELECT state, retry_count FROM pgboss.job WHERE name = $1 AND id = $2 FOR UPDATE",
                [handler.name, job.id],
              );
              if (
                claim.rows[0]?.state !== "active" ||
                claim.rows[0].retry_count !== job.retryCount
              ) {
                throw new Error("Handler attempt lost its claim");
              }
              const receipt = await tx.query(
                "INSERT INTO handler_receipts VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING event_id",
                [handler.name, event.id],
              );
              if (receipt.rows.length) {
                await handler.handle(event, tx);
              }
              job.signal.throwIfAborted();
            },
          ),
        ),
    );
  }

  /** Failed originals remain the durable dead-letter index, even after diagnostic copies expire. */
  async deadLetters(name: Handler["name"]) {
    return (await this.boss.findJobs<unknown>(name)).filter(
      (job) => job.state === "failed",
    );
  }

  /** Repair the original FIFO head; never redrive the diagnostic copy behind successors. */
  async replay(name: Handler["name"], id: string): Promise<void> {
    await this.options.db.transaction(async (tx) => {
      const result = await tx.query<{ state: string }>(
        "SELECT state FROM pgboss.job WHERE name = $1 AND id = $2 FOR UPDATE",
        [name, id],
      );
      if (result.rows[0]?.state !== "failed") {
        throw new Error("Dead-letter head not found");
      }
      await this.boss.retry(name, id, { db: transactionAdapter(tx) });
    });
  }

  async stop(): Promise<void> {
    await this.boss.stop({ graceful: true, timeout: 10_000 });
  }
}
