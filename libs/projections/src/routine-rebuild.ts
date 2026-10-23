import { isDeepStrictEqual } from 'node:util';
import type { Logger } from '@opencrane/observability';
import type { Db, Query } from './db.ts';
import { ProjectionRunner, type EventSource } from './runner.ts';
import { routines } from './routines.ts';

async function rows(db: Query) {
  const current = await db.query('SELECT * FROM routines ORDER BY silo, routine_id');
  const occurrences = await db.query(
    'SELECT * FROM routine_occurrences ORDER BY silo, routine_id, occurrence_id');
  return { current: current.rows, occurrences: occurrences.rows };
}

/** Keep readers and workers stopped until the entire rebuild has committed. */
export async function rebuildRoutineProjection(db: Db, source: EventSource,
  logger: Logger, { verify = false } = {}) {
  if (!db.lock) throw new Error('Routine rebuild requires projection locking');
  async function rebuild(locked: Db) {
    const live = new ProjectionRunner(locked, source, logger);
    await live.initialise(routines);
    const checkpoint = await live.checkpoint(routines);
    const head = await source.head();
    async function replace(tx: Query) {
      const before = await rows(tx);
      // Reuse the runner inside this one transaction, so interruption also restores receipts.
      const transactionDb: Db = { query: tx.query.bind(tx), transaction: work => work(tx) };
      const priorSource = { head: () => Promise.resolve(checkpoint),
        subscribe: source.subscribe.bind(source) };
      const runner = new ProjectionRunner(transactionDb, priorSource, logger);
      await runner.rebuild(routines);
      const rebuilt = await rows(tx);
      const changed = !isDeepStrictEqual(before, rebuilt);
      if (verify && changed) throw new Error('Rebuilt routines differ from the live projection');
      const catchUp = new ProjectionRunner(transactionDb, source, logger);
      const options = { toSequence: head };
      await catchUp.run(routines, options);
      return { previousSequence: checkpoint, sequence: head, verified: verify, changed };
    }
    return locked.transaction(replace);
  }
  return db.lock(routines.name, rebuild);
}
