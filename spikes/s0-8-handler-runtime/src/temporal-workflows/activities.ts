// Activities are Temporal's retryable unit: ordinary async functions that run
// outside the workflow's deterministic sandbox, so they may do real I/O. The
// workflow calls them through a typed proxy and Temporal handles retries and
// timeouts.
import { Context } from '@temporalio/activity';
import pg from 'pg';
import type { HandlerRun } from '../scenario.ts';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Ordering / retry handlers (in-memory "handler", observed by the test)
// ---------------------------------------------------------------------------

export interface ApplyEventInput {
  key: string;
  seq: number;
  delayMs?: number | undefined;
  /** Always throws. */
  poison?: boolean | undefined;
  /** Throws while the attempt number is at or below this value. */
  failUntilAttempt?: number | undefined;
}

/**
 * Every handler run, as observed from inside the handler. The worker runs in
 * the test's own process, so the test reads these directly. This is the same
 * evidence the pg-boss tests use: the handler's own start and end times.
 */
export const activityRuns: HandlerRun[] = [];

/** Every attempt (including failed ones), for the retry and visibility tests. */
/** Switches the tests flip while running (the activity runs in the test's own process). */
export const control = { poisonFixed: false };

export const attemptLog: { key: string; seq: number; attempt: number; at: number; failed: boolean }[] = [];

export async function applyEvent(input: ApplyEventInput): Promise<{ key: string; seq: number }> {
  const attempt = Context.current().info.attempt;
  const start = performance.now();
  const fail =
    (input.poison === true && !control.poisonFixed) ||
    (input.failUntilAttempt !== undefined && attempt <= input.failUntilAttempt);
  attemptLog.push({ key: input.key, seq: input.seq, attempt, at: start, failed: fail });
  if (fail) {
    throw new Error(`deliberate failure: key=${input.key} seq=${input.seq} attempt=${attempt}`);
  }
  if (input.delayMs) await sleep(input.delayMs);
  activityRuns.push({ key: input.key, seq: input.seq, start, end: performance.now() });
  return { key: input.key, seq: input.seq };
}

// ---------------------------------------------------------------------------
// Crash-recovery handler (a real side effect in PostgreSQL)
// ---------------------------------------------------------------------------

export interface ApplyEffectInput {
  connectionString: string;
  /** Table with a primary key on idempotency_key (guarded) or without one (control). */
  effectsTable: string;
  idempotencyKey: string;
  /** When true, skip the effect if the key is already recorded. */
  guarded: boolean;
  /** Time spent working before the effect lands (the "crash before the effect" window). */
  sleepBeforeEffectMs: number;
  /** Time spent after the effect lands and before the activity returns (the "crash before the ack" window). */
  holdAfterEffectMs: number;
}

/** Sleep in short steps, telling Temporal the activity is alive each step. */
async function sleepWithHeartbeat(ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    Context.current().heartbeat();
    await sleep(Math.min(250, Math.max(1, end - Date.now())));
  }
}

export async function applyEffect(input: ApplyEffectInput): Promise<{ alreadyApplied: boolean; attempt: number }> {
  const attempt = Context.current().info.attempt;
  const db = new pg.Client({ connectionString: input.connectionString });
  await db.connect();
  try {
    if (input.guarded) {
      const existing = await db.query(`SELECT 1 FROM ${input.effectsTable} WHERE idempotency_key = $1`, [
        input.idempotencyKey,
      ]);
      if ((existing.rowCount ?? 0) > 0) {
        console.log(`ACTIVITY already-applied ${input.idempotencyKey} attempt=${attempt}`);
        return { alreadyApplied: true, attempt };
      }
    }
    console.log(`ACTIVITY started ${input.idempotencyKey} attempt=${attempt}`);
    await sleepWithHeartbeat(input.sleepBeforeEffectMs);
    await db.query(
      `INSERT INTO ${input.effectsTable} (idempotency_key, applied_at) VALUES ($1, now())
       ${input.guarded ? 'ON CONFLICT (idempotency_key) DO NOTHING' : ''}`,
      [input.idempotencyKey],
    );
    console.log(`ACTIVITY effect-applied ${input.idempotencyKey} attempt=${attempt}`);
    await sleepWithHeartbeat(input.holdAfterEffectMs);
    return { alreadyApplied: false, attempt };
  } finally {
    await db.end();
  }
}

// ---------------------------------------------------------------------------
// Budget actor: the durable write behind every reserve and settle answer
// ---------------------------------------------------------------------------

export interface BudgetEntryInput {
  connectionString: string;
  key: string;
  op: 'reserve' | 'settle';
  amountCents: number;
  /** The change this entry makes to the held balance. */
  deltaCents: number;
  requestId: string;
  /** Up to this much extra time the write takes (only the negative control uses it, to widen the race). */
  extraDelayMs?: number | undefined;
}

const pools = new Map<string, pg.Pool>();
function poolFor(connectionString: string): pg.Pool {
  let pool = pools.get(connectionString);
  if (!pool) {
    pool = new pg.Pool({ connectionString, max: 10 });
    pool.on('error', () => undefined);
    pools.set(connectionString, pool);
  }
  return pool;
}

/** Record one budget entry. Idempotent on the request id, so a retry cannot double-count. */
export async function appendBudgetEntry(input: BudgetEntryInput): Promise<void> {
  // A random share of the extra delay, so writes finish at different times and the requests overlap.
  if (input.extraDelayMs) await sleep(Math.round(input.extraDelayMs * (0.3 + Math.random() * 0.7)));
  await poolFor(input.connectionString).query(
    `INSERT INTO budget_log (request_id, key, op, amountCents, deltaCents) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (request_id) DO NOTHING`,
    [input.requestId, input.key, input.op, input.amountCents, input.deltaCents],
  );
}

/** Close pooled connections (called by tests before they stop PostgreSQL). */
export async function closeBudgetPools(): Promise<void> {
  await Promise.all([...pools.values()].map((p) => p.end()));
  pools.clear();
}
