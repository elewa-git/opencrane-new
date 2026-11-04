import { setTimeout as delay } from 'node:timers/promises';
import { connectProjectionDb, type Db } from '@opencrane/projections';

interface Options {
  databaseUrl: string;
  silo: string;
  signal: AbortSignal;
}
interface Leadership {
  signal: AbortSignal;
  checkCurrent: (deadline: number) => Promise<boolean>;
}

/** Keep one session for the whole callback, including its cancellation cleanup. */
export async function withRoutineLeadership(options: Options,
  work: (lease: Leadership) => Promise<void>): Promise<void> {
  const stop = new AbortController();
  function cancel() {
    stop.abort();
  }
  const listenerOptions = { once: true };
  options.signal.addEventListener('abort', cancel, listenerOptions);
  if (options.signal.aborted) cancel();
  const database = connectProjectionDb(options.databaseUrl, cancel);
  async function held(locked: Db) {
    const checks = new Set<Promise<boolean>>();
    async function verify(deadline: number) {
      if (stop.signal.aborted || performance.now() >= deadline) return false;
      try {
        const queryDeadline = Math.min(deadline, performance.now() + 1000);
        const queryOptions = { deadline: queryDeadline };
        await locked.query('SELECT 1', [], queryOptions);
        return !stop.signal.aborted && performance.now() < deadline;
      } catch {
        cancel();
        return false;
      }
    }
    async function checkCurrent(deadline: number) {
      const pending = verify(deadline);
      checks.add(pending);
      try {
        return await pending;
      } finally {
        checks.delete(pending);
      }
    }
    async function monitor() {
      try {
        while (!stop.signal.aborted) {
          await checkCurrent(performance.now() + 1000);
          const delayOptions = { signal: stop.signal };
          await delay(100, undefined, delayOptions);
        }
      } catch {
        cancel();
      }
    }
    const watching = monitor();
    try {
      const lease = { signal: stop.signal, checkCurrent };
      await work(lease);
    } finally {
      // Refuse captured callbacks before draining checks and returning the session.
      cancel();
      await watching;
      await Promise.allSettled(checks);
    }
  }
  try {
    const acquisition = { timeoutMs: 1000, signal: stop.signal };
    await database.db.lock!(`routine-leader:${options.silo}`, held, acquisition);
  } catch {
    throw new Error('Routine leadership unavailable');
  } finally {
    cancel();
    options.signal.removeEventListener('abort', cancel);
    await database.close();
  }
}
