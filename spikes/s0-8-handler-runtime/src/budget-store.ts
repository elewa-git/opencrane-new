// Test double only: these disposable tables do not implement the event-store command path.
import { assertCents } from './money.ts';
// The budget handler shared by the pg-boss tests and the in-process baseline.
// It is deliberately written as a plain read-then-write (read the balance,
// decide, write the new balance back) with a small gap between the read and
// the write. Run by two writers at once, that shape loses updates and
// overspends. It is only safe when the runtime guarantees ONE writer per key,
// which is exactly the property under test. Each test also runs it WITHOUT
// that guarantee (a negative control) and must see an overspend.
import pg from 'pg';

export interface BudgetRequest {
  op: 'reserve' | 'settle';
  requestId: string;
  key: string;
  /** reserve: the amount to hold. settle: the amount actually used. */
  amountCents: number;
  /** settle only: the amount that was held earlier. */
  reservedAmountCents?: number;
}

export interface BudgetAnswer {
  requestId: string;
  accepted: boolean;
  reservedCents: number;
  ceilingCents: number;
}

export async function createBudgetTables(pool: pg.Pool): Promise<void> {
  await pool.query(`CREATE TABLE IF NOT EXISTS budgets (key text PRIMARY KEY, ceilingCents integer NOT NULL, reservedCents integer NOT NULL)`);
  // One row per accepted request, in the order it was applied (id). `deltaCents` is
  // the change it made to the held balance: +amount for a reserve, and
  // (used - held) for a settle. The balance after any prefix of the log is
  // the sum of its deltas, which is how the tests check "never above the
  // ceiling" for every moment, not just at the end.
  await pool.query(
    `CREATE TABLE IF NOT EXISTS budget_log (
       id bigserial PRIMARY KEY, request_id text UNIQUE NOT NULL, key text NOT NULL, op text NOT NULL,
       amountCents integer NOT NULL, deltaCents integer NOT NULL, at timestamptz NOT NULL DEFAULT now())`,
  );
}

export async function createBudget(pool: pg.Pool, key: string, ceilingCents: number): Promise<void> {
  assertCents(ceilingCents);
  await pool.query(`INSERT INTO budgets (key, ceilingCents, reservedCents) VALUES ($1, $2, 0)`, [key, ceilingCents]);
}

/** Apply one request: read, decide, write, record. NOT safe with two writers on one key. */
export async function applyBudgetRequest(pool: pg.Pool, req: BudgetRequest, gapMs = 1): Promise<BudgetAnswer> {
  assertCents(req.amountCents);
  if (req.reservedAmountCents !== undefined) assertCents(req.reservedAmountCents);
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const { rows } = await db.query<{ reservedCents: string; ceilingCents: string }>(
      `SELECT reservedCents AS "reservedCents", ceilingCents AS "ceilingCents" FROM budgets WHERE key = $1`,
      [req.key],
    );
    const ceilingCents = Number(rows[0]!.ceilingCents);
    let reservedCents = Number(rows[0]!.reservedCents);
    await new Promise((resolve) => setTimeout(resolve, gapMs)); // the window a second writer would exploit
    let accepted = true;
    if (req.op === 'reserve') {
      if (reservedCents + req.amountCents > ceilingCents) accepted = false;
      else reservedCents += req.amountCents;
    } else {
      reservedCents = reservedCents - (req.reservedAmountCents ?? 0) + req.amountCents;
    }
    if (accepted) {
      await db.query(`UPDATE budgets SET reservedCents = $2 WHERE key = $1`, [req.key, reservedCents]);
      const deltaCents = req.op === 'reserve' ? req.amountCents : req.amountCents - (req.reservedAmountCents ?? 0);
      await db.query(
        `INSERT INTO budget_log (request_id, key, op, amountCents, deltaCents) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
        [req.requestId, req.key, req.op, req.amountCents, deltaCents],
      );
    }
    await db.query('COMMIT');
    return { requestId: req.requestId, accepted, reservedCents, ceilingCents };
  } catch (err) {
    await db.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    db.release();
  }
}

export async function readBudget(pool: pg.Pool, key: string): Promise<{ reservedCents: number; ceilingCents: number; logged: number }> {
  const b = await pool.query<{ reservedCents: string; ceilingCents: string }>(`SELECT reservedCents AS "reservedCents", ceilingCents AS "ceilingCents" FROM budgets WHERE key = $1`, [key]);
  const l = await pool.query<{ n: string }>(`SELECT count(*) AS n FROM budget_log WHERE key = $1`, [key]);
  return { reservedCents: Number(b.rows[0]!.reservedCents), ceilingCents: Number(b.rows[0]!.ceilingCents), logged: Number(l.rows[0]!.n) };
}

/**
 * Replay the durable log of one key in order. Returns the highest balance the
 * log ever reached, its final balance and its length. A correct single writer
 * never lets the running balance pass the ceiling.
 */
export async function replayLog(
  pool: pg.Pool,
  key: string,
): Promise<{ maxRunningCents: number; finalBalanceCents: number; entries: number }> {
  const { rows } = await pool.query<{ deltaCents: string }>(`SELECT deltaCents AS "deltaCents" FROM budget_log WHERE key = $1 ORDER BY id`, [key]);
  let running = 0;
  let max = 0;
  for (const r of rows) {
    running += Number(r.deltaCents);
    if (running > max) max = running;
  }
  return { maxRunningCents: max, finalBalanceCents: running, entries: rows.length };
}
