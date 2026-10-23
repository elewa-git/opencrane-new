import { handlerJobKey } from './job-key.ts';
import { isDeepStrictEqual } from 'node:util';
import { PgBoss, type Queue, type JobWithMetadata } from "pg-boss";
import { parseEventByType, type EventEnvelope } from "@opencrane/events";
import { runHandler, type Logger } from "@opencrane/observability";
import type { Db, Query } from "@opencrane/projections";
import { withinAttempt } from "./attempt.ts";
import { checkHandlers, type Handler, type HandlerAttempt } from "./registration.ts";

function transactionAdapter(tx: Query) {
  return {
    executeSql: (sql: string, values?: unknown[]) => tx.query(sql, values),
  };
}

// Set queued events to infinity before commit because pg-boss has no such setting.
// Keep failed stream heads too, so later events cannot pass them.
// Use the insertion time so backfill jobs in one transaction keep their event order.
async function retainJob(
  tx: Query,
  name: string,
  id: string,
): Promise<void> {
  await tx.query(
    "UPDATE pgboss.job SET keep_until = 'infinity', created_on = clock_timestamp() " +
      "WHERE name = $1 AND id = $2",
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

/** Use a dedicated pg-boss schema in the supplied silo database. */
export class HandlerRuntime {
  private scheduler: PgBoss | undefined;
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

  async enqueue(handler: Handler, event: EventEnvelope, tx: Query): Promise<void> {
    const singletonKey = handlerJobKey(handler.name, event);
    const id = await this.boss.send(handler.name, event, {
      singletonKey,
      db: transactionAdapter(tx),
    });
    if (!id) {
      throw new Error("Handler enqueue refused");
    }
    await retainJob(tx, handler.name, id);
  }

  /** Hold historical jobs until the scan has finished and workers can use the new subscriptions. */
  async enqueueBatch(handler: Handler, events: EventEnvelope[], tx: Query,
    queuedBefore: number): Promise<number> {
    if (!events.length) {
      return 0;
    }
    function job(event: EventEnvelope) {
      const singletonKey = handlerJobKey(handler.name, event);
      return { data: event, singletonKey };
    }
    const jobs = events.map(job);
    const options = { db: transactionAdapter(tx), returnId: true };
    const ids = await this.boss.insert(handler.name, jobs, options);
    if (!ids || ids.length !== jobs.length) {
      throw new Error('Handler batch enqueue refused');
    }
    // Give every saved batch a lasting order before any later live job can arrive.
    // Leave enough time slots for every possible match through the target checkpoint.
    await tx.query(
      "UPDATE pgboss.job AS job SET keep_until = 'infinity', start_after = 'infinity', " +
      "created_on = (SELECT created_on - target * $3::int * interval '1 microsecond' " +
      "FROM handler_upgrade WHERE id = 1) + ($4::bigint + batch.ordinal) * interval '1 microsecond' " +
      "FROM unnest($2::uuid[]) WITH ORDINALITY AS batch(id, ordinal) " +
      "WHERE job.name = $1 AND job.id = batch.id",
      [handler.name, ids, this.options.handlers.length, queuedBefore],
    );
    return ids.length;
  }

  async work(concurrency = 4): Promise<void> {
    for (const handler of this.options.handlers) {
      const workOptions = {
        includeMetadata: true,
        batchSize: 1,
        localConcurrency: concurrency,
        pollingIntervalSeconds: 0.5,
      } as const;
      const processJobs = async (jobs: JobWithMetadata<unknown>[]) => {
        const job = jobs[0];
        if (job) await this.apply(handler, job);
      };
      const processDeadJobs = async (jobs: JobWithMetadata<unknown>[]) => {
        const job = jobs[0];
        if (job) await this.recordExhaustion(handler, job);
      };
      await this.boss.work<unknown, void, typeof workOptions>(
        handler.name, workOptions, processJobs,
      );
      if (handler.exhausted) {
        await this.boss.work<unknown, void, typeof workOptions>(
          `${handler.name}-dead`, workOptions, processDeadJobs,
        );
      }
    }
  }

  private async recordExhaustion(handler: Handler, job: JobWithMetadata<unknown>): Promise<void> {
    const parsed = parseEventByType(job.data);
    const originalId = job.sourceId;
    if (!parsed.success || !originalId || !handler.eventTypes.includes(parsed.event.type) ||
        parsed.event.silo !== this.options.silo ||
        handlerJobKey(handler.name, parsed.event) !== job.singletonKey) {
      throw new Error('Invalid cleanup dead-letter job');
    }
    await this.reportFailedOriginal(handler, parsed.event, originalId, job.data);
  }

  /** Report a retained failed job, including when its diagnostic copy also failed. */
  async reportFailedOriginal(
    handler: Handler,
    event: EventEnvelope,
    originalId: string,
    expectedData: unknown = event,
  ): Promise<boolean> {
    if (handler.name !== 'cleanup-memory' ||
        (event.type !== 'memory.forgotten' && event.type !== 'memory.corrected') ||
        event.silo !== this.options.silo) {
      throw new Error('Invalid cleanup original');
    }
    const original = await this.options.db.query<{ state: string; data: unknown }>(
      'SELECT state, data FROM pgboss.job WHERE name=$1 AND id=$2',
      [handler.name, originalId],
    );
    const saved = original.rows[0];
    if (saved?.state !== 'failed' || !isDeepStrictEqual(saved.data, expectedData)) {
      return false;
    }
    if (!handler.exhausted) throw new Error('Cleanup exhaustion handler missing');
    const appended = await handler.exhausted(event);
    if (appended) {
      const fields = { changeId: event.id,
        scopeId: event.subject.slice('scope-'.length), jobId: originalId };
      this.options.logger.error(fields, 'Memory cleanup retries exhausted');
    }
    return appended;
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
      handlerJobKey(handler.name, parsed.event) !== job.singletonKey
    ) {
      throw new Error("Invalid handler job");
    }
    const event = parsed.event;
    const database = this.options.db;
    async function attempt(tx: Query, context: HandlerAttempt) {
      // Hold this attempt until commit, so expiry or replay cannot start
      // another SQL writer while the transaction is running.
      const claim = await tx.query<{ state: string; retry_count: number }>(
        'SELECT state, retry_count FROM pgboss.job WHERE name = $1 AND id = $2 FOR UPDATE',
        [handler.name, job.id],
      );
      if (claim.rows[0]?.state !== 'active' || claim.rows[0].retry_count !== job.retryCount) {
        throw new Error('Handler attempt lost its claim');
      }
      const receipt = await tx.query(
        'INSERT INTO handler_receipts VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING event_id',
        [handler.name, event.id],
      );
      if (receipt.rows.length) {
        await handler.handle(event, tx, context);
      }
      job.signal.throwIfAborted();
    }
    async function transactionWork(transaction: Query) {
      await withinAttempt(transaction, job.signal, job.expireInSeconds, attempt);
    }
    async function perform() {
      await database.transaction(transactionWork);
    }
    if (handler.name === 'cleanup-memory' || handler.name === 'cleanup-connection') {
      // Keep custody errors out of logs and the job queue's saved error output.
      try {
        await perform();
      } catch {
        const failure = handler.name === 'cleanup-memory'
          ? 'Memory cleanup attempt failed' : 'Connection cleanup attempt failed';
        throw new Error(failure);
      }
      return;
    }
    const run = { handler: handler.name, eventId: event.id, eventType: event.type,
      stream: event.subject, attempt: job.retryCount + 1 };
    await runHandler(this.options.logger, run, perform);
  }

  /** Keep failed originals as the lasting failure list after diagnostic copies expire. */
  async deadLetters(name: Handler["name"]) {
    return (await this.boss.findJobs<unknown>(name)).filter(
      (job) => job.state === "failed",
    );
  }

  /** Retry the original first job; never retry its copy after later jobs. */
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

  async startNightly(scan: (occurrence: Date) => Promise<void>): Promise<void> {
    await scheduleNightly(this.boss, this.options.silo, scan);
    const database = transactionAdapter(this.options.db);
    const schedulerOptions = { db: database, supervise: false };
    const scheduler = new PgBoss(schedulerOptions);
    this.scheduler = scheduler;
    const logger = this.options.logger;
    function failed(err: Error) {
      const fields = { err };
      logger.error(fields, 'Nightly scheduler failed');
    }
    scheduler.on('error', failed);
    // Start the native timekeeper only after the host has registered its workers and manifest.
    await scheduler.start();
    const payload = { silo: this.options.silo };
    await this.boss.send('dream-nightly', payload);
  }

  async stop(): Promise<void> {
    await this.scheduler?.stop();
    await this.boss.stop({ graceful: true, timeout: 10_000 });
  }
}

async function recoverNightly(boss: PgBoss, silo: string,
  scan: (occurrence: Date) => Promise<void>) {
  const payload = { silo };
  const options = { data: payload };
  const jobs = await boss.findJobs<{ silo: string }>('dream-nightly', options);
  for (const job of jobs) {
    if (job.state !== 'failed') {
      continue;
    }
    // Keep the failed trigger until every scope has a saved result for its original night.
    await scan(job.createdOn);
    await boss.deleteJob('dream-nightly', job.id);
  }
}

export async function scheduleNightly(boss: PgBoss, silo: string,
  scan: (occurrence: Date) => Promise<void>) {
  // Retain exhausted triggers so startup or a later night can recover them.
  const queue = { retryLimit: 5, retryDelay: 1, retryBackoff: true, deleteAfterSeconds: 0 };
  await boss.createQueue('dream-nightly', queue);
  await boss.updateQueue('dream-nightly', queue);
  async function deliver(jobs: JobWithMetadata<{ silo: string }>[]) {
    for (const job of jobs) {
      if (job.data.silo !== silo) {
        throw new Error('Foreign nightly trigger');
      }
      await recoverNightly(boss, silo, scan);
      await scan(job.createdOn);
    }
  }
  const workOptions = { includeMetadata: true } as const;
  await boss.work('dream-nightly', workOptions, deliver);
  const options = { tz: 'UTC', key: silo, missed: 'skip' as const };
  const payload = { silo };
  await boss.schedule('dream-nightly', '0 2 * * *', payload, options);
}
