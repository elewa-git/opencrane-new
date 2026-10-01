// Small helpers shared by the pg-boss test files.
import { PgBoss, type ConstructorOptions, type Job, type WorkOptions } from 'pg-boss';
import { createHash } from 'node:crypto';

export interface TestBoss {
  boss: PgBoss;
  /** Every 'error' event pg-boss emitted. Tests assert this stays empty. */
  errors: unknown[];
}

/** Start a pg-boss instance against a connection string. */
export async function startBoss(connectionString: string, extra: Partial<ConstructorOptions> = {}): Promise<TestBoss> {
  const boss = new PgBoss({ connectionString, ...extra });
  const errors: unknown[] = [];
  // pg-boss emits 'error' for problems inside its own loops; without a
  // listener Node would throw. Collect them so tests can assert on them.
  boss.on('error', (err) => errors.push(err));
  await boss.start();
  return { boss, errors };
}

export async function stopBoss(t: TestBoss | undefined): Promise<void> {
  await t?.boss.stop({ graceful: false, timeout: 2000 }).catch(() => undefined);
}

export type JobHandler<T> = (job: Job<T>) => Promise<unknown>;

/**
 * Register `count` separate single-slot workers on one queue, started
 * `staggerMs` apart. Workers created together poll in lock-step (they all
 * wake at the same instant), so a successor job on a held key waits a full
 * polling interval. Staggering their start spreads the polls out. This is
 * the setting that matters most for per-stream latency; see the dispatcher
 * test for the measurement.
 */
export async function startStaggeredWorkers<T>(
  boss: PgBoss,
  queue: string,
  count: number,
  options: WorkOptions,
  handler: JobHandler<T>,
  staggerMs = 12,
): Promise<void> {
  for (let i = 0; i < count; i++) {
    await boss.work<T>(queue, { ...options, localConcurrency: 1, batchSize: 1 }, async (jobs) => {
      const job = jobs[0];
      if (!job) return undefined;
      return handler(job);
    });
    if (staggerMs > 0) await new Promise((r) => setTimeout(r, staggerMs));
  }
}

/**
 * A stable job id made from an event id (a version-5 style UUID built from a
 * SHA-1 hash). The dispatcher uses it so that enqueueing the same event twice
 * creates one job: pg-boss ignores a send whose id already exists.
 */
export function jobIdForEvent(eventId: string): string {
  const hash = createHash('sha1').update(`opencrane-event:${eventId}`).digest();
  hash[6] = ((hash[6] as number) & 0x0f) | 0x50; // version 5
  hash[8] = ((hash[8] as number) & 0x3f) | 0x80; // RFC 4122 variant
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
