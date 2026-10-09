import { setTimeout as delay } from 'node:timers/promises';
import { readEvents, type EventSource, type Query } from '@opencrane/projections';
import type { EventEnvelope } from '@opencrane/events';
import type { HandlerRuntime } from './queue.ts';
export interface SubscriptionChange {
  handler: string;
  addedTypes: string[];
  removedTypes: string[];
  eventCount: number;
}

export async function requireOnlySession(db: Query): Promise<void> {
  const sessions = await db.query(
    'SELECT pid FROM pg_stat_activity WHERE datname = current_database() ' +
    'AND pid <> pg_backend_pid()',
  );
  if (sessions.rows.length) {
    throw new Error('There are other database sessions connected to the handlers database; ' +
      'stop every worker, dispatcher and database client before upgrading');
  }
}

export interface UpgradeProgress extends Record<string, unknown> {
  manifest: string;
  previous: string;
  target: string;
  sequence: string;
  counts: SubscriptionChange[];
  jobs: string;
}
const chunkSize = 256;

async function readChunk(source: EventSource, from: number, to: number,
  runtime: HandlerRuntime) {
  for (let attempt = 0; ; attempt++) {
    const rows: EventEnvelope[] = [];
    try {
      for await (const row of readEvents(source, from, to)) {
        if (row.event.silo !== runtime.options.silo) {
          throw new Error('Dispatcher silo mismatch in EVENTS history');
        }
        rows.push(row.event);
      }
      return rows;
    } catch (error) {
      if (!(error instanceof Error) ||
          (error.name !== 'TimeoutError' &&
            !['EVENTS stream is incomplete', 'timeout', 'TIMEOUT'].includes(error.message)) ||
          attempt >= 5) {
        throw error;
      }
      const retryInMs = Math.min(250 * 2 ** attempt, 4000);
      const fields = { fromSequence: from, retryInMs };
      runtime.options.logger.warn(fields, 'History read timed out; retrying the same chunk');
      await delay(retryInMs);
    }
  }
}

async function queueChunk(runtime: HandlerRuntime, events: EventEnvelope[],
  changes: SubscriptionChange[], tx?: Query, queuedBefore = 0): Promise<number> {
  let queued = 0;
  for (const change of changes) {
    function matches(event: EventEnvelope) {
      return change.addedTypes.includes(event.type);
    }
    const matching = events.filter(matches);
    change.eventCount += matching.length;
    if (!tx || !matching.length) {
      continue;
    }
    function named(handler: typeof runtime.options.handlers[number]) {
      return handler.name === change.handler;
    }
    const handler = runtime.options.handlers.find(named);
    if (!handler) {
      throw new Error('Backfill handler missing');
    }
    queued += await runtime.enqueueBatch(handler, matching, tx, queuedBefore + queued);
  }
  return queued;
}

export async function scanUpgrade(runtime: HandlerRuntime, source: EventSource,
  changes: SubscriptionChange[], target: number, manifest: string, previous: string,
  progress: UpgradeProgress | undefined, dryRun: boolean): Promise<SubscriptionChange[]> {
  let sequence = Number(progress?.sequence ?? 0);
  let queued = Number(progress?.jobs ?? 0);
  const counts = progress?.counts ?? changes;
  function hasAdded(change: SubscriptionChange) {
    return change.addedTypes.length > 0;
  }
  const needsHistory = counts.some(hasAdded);
  if (!dryRun) {
    await runtime.options.db.query(`CREATE TABLE IF NOT EXISTS handler_upgrade (
      id INTEGER PRIMARY KEY CHECK (id = 1), manifest TEXT NOT NULL, previous TEXT NOT NULL,
      target BIGINT NOT NULL, sequence BIGINT NOT NULL, counts JSONB NOT NULL, jobs BIGINT NOT NULL,
      created_on TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp())`);
    await runtime.options.db.query(
      'INSERT INTO handler_upgrade (id, manifest, previous, target, sequence, counts, jobs) ' +
      'VALUES (1, $1, $2, $3, 0, $4, 0) ON CONFLICT DO NOTHING',
      [manifest, previous, target, JSON.stringify(counts)],
    );
  }
  if (!needsHistory) {
    const fields = { changes };
    let message = 'Only subscription order changed; no history scan is needed';
    if (changes.length) {
      message = 'Only subscriptions were removed; no history scan is needed';
    }
    runtime.options.logger.info(fields, message);
    return counts;
  }
  while (sequence < target) {
    if (!dryRun) {
      await requireOnlySession(runtime.options.db);
    }
    const end = Math.min(sequence + chunkSize, target);
    const events = await readChunk(source, sequence + 1, end, runtime);
    if (dryRun) {
      await queueChunk(runtime, events, counts);
    } else {
      async function saveChunk(tx: Query) {
        const jobs = await queueChunk(runtime, events, counts, tx, queued);
        await tx.query('UPDATE handler_upgrade SET sequence = $1, counts = $2, jobs = $3 WHERE id = 1',
          [end, JSON.stringify(counts), queued + jobs]);
        return jobs;
      }
      queued += await runtime.options.db.transaction(saveChunk);
    }
    sequence = end;
    const fields = { eventsScanned: sequence, jobsQueued: queued, target };
    runtime.options.logger.info(fields, 'Handler upgrade scan progress');
  }
  return counts;
}
