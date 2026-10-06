import type { Query } from "@opencrane/projections";

/** Roll back on abort even when the handler ignores cancellation. */
export async function withinAttempt<T>(
  transaction: Query,
  signal: AbortSignal,
  seconds: number,
  work: (query: Query) => Promise<T>,
): Promise<T> {
  signal.throwIfAborted();
  const deadline = performance.now() + seconds * 1000;
  let open = true;
  function check() {
    if (!open || signal.aborted) {
      throw new Error("Handler transaction is closed");
    }
  }
  let tail = Promise.resolve();
  let failed = false;
  const query: Query = {
    query<Row extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
      values?: unknown[],
    ) {
      // Run each operation in turn, including its timeout calculation.
      // Otherwise a waiting call could use an old timeout.
      const operation = tail.then(async () => {
        check();
        await transaction.query(
          `SELECT set_config('statement_timeout',
          LEAST(NULLIF(setting::int, 0), $1)::text, true)
          FROM pg_settings WHERE name = 'statement_timeout'`,
          [Math.max(1, Math.ceil(deadline - performance.now()))],
        );
        check();
        return transaction.query<Row>(sql, values);
      });
      // Release the slot after success or failure, while still passing failures
      // back to the caller. A caught SQL error must not make rollback succeed.
      tail = operation.then(
        () => undefined,
        () => {
          failed = true;
        },
      );
      return operation;
    },
  };
  let abort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    abort = () =>
      reject(new Error("Handler attempt aborted", { cause: signal.reason }));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
    }
  });
  try {
    const result = await Promise.race([work(query), aborted]);
    await tail;
    if (failed) {
      throw new Error("Handler SQL failed");
    }
    return result;
  } finally {
    // The callback may resume later. Block SQL after commit or rollback has
    // returned the pooled connection for another caller to use.
    open = false;
    signal.removeEventListener("abort", abort);
  }
}
