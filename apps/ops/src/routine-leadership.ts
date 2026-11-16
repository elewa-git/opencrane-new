import { setTimeout as delay } from 'node:timers/promises';
import { connectProjectionDb, type Db } from '@opencrane/projections';
import { createLogger, type Logger } from '@opencrane/observability';

interface Options {
  databaseUrl: string;
  silo: string;
  signal: AbortSignal;
  logger?: Logger;
}
interface Leadership {
  signal: AbortSignal;
  checkCurrent: (deadline: number) => Promise<boolean>;
}

const safeMessages = new Set([
  'Database lock acquisition cancelled or expired', 'Database lock acquisition expired',
  'Database lock session lost', 'Database read expired', 'Query read timeout',
  'Connection terminated unexpectedly', 'Connection terminated',
  'Connection terminated due to connection timeout', 'Routine scan unavailable',
]);
const safeCodes = new Set(['55P03', '57014', '57P01', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT']);

function logFailure(logger: Logger, error: unknown, phase: string) {
  let message = 'Unclassified error';
  let code: string | undefined;
  // Keep known adapter causes, but never copy arbitrary messages, SQL, addresses or stacks.
  if (error instanceof Error) {
    if (safeMessages.has(error.message)) message = error.message;
    if ('code' in error && typeof error.code === 'string' && safeCodes.has(error.code)) {
      code = error.code;
    }
  }
  const err = { message, code };
  logger.error({ phase, err }, 'Routine leadership failed');
}

function leadershipRefused(logger: Logger, error: unknown, phase: string) {
  logFailure(logger, error, phase);
  return new Error('Routine leadership unavailable');
}

/** Keep one session for the whole callback, including its cancellation cleanup. */
export async function withRoutineLeadership(options: Options,
  work: (lease: Leadership) => Promise<void>): Promise<void> {
  const stop = new AbortController();
  const logger = options.logger ?? createLogger('routine-leadership');
  let phase = 'acquire';
  let database: ReturnType<typeof connectProjectionDb> | undefined;
  function cancel() {
    stop.abort();
  }
  const listenerOptions = { once: true };
  options.signal.addEventListener('abort', cancel, listenerOptions);
  if (options.signal.aborted) cancel();
  function sessionFailed(error: Error) {
    logFailure(logger, error, 'session');
    cancel();
  }
  async function held(locked: Db) {
    phase = 'work';
    const checks = new Set<Promise<boolean>>();
    async function verify(deadline: number) {
      if (stop.signal.aborted || performance.now() >= deadline) return false;
      try {
        const queryDeadline = Math.min(deadline, performance.now() + 1000);
        const queryOptions = { deadline: queryDeadline };
        await locked.query('SELECT 1', [], queryOptions);
        return !stop.signal.aborted && performance.now() < deadline;
      } catch (error) {
        logFailure(logger, error, 'probe');
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
      phase = 'release';
    } finally {
      // Refuse captured callbacks before draining checks and returning the session.
      cancel();
      await watching;
      await Promise.allSettled(checks);
    }
  }
  try {
    database = connectProjectionDb(options.databaseUrl, sessionFailed);
    const acquisition = { timeoutMs: 1000, signal: stop.signal };
    await database.db.lock!(`routine-leader:${options.silo}`, held, acquisition);
  } catch (error) {
    throw leadershipRefused(logger, error, phase);
  } finally {
    cancel();
    options.signal.removeEventListener('abort', cancel);
    await database?.close();
  }
}
