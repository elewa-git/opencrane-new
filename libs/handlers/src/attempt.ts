import type { Query } from "@opencrane/projections";

/** End the transaction on abort, even if the handler ignores cancellation. */
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
      // Serialise the whole operation, including its timeout calculation.
      // Concurrent callers must not queue SQL with stale timeout settings.
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
      // Release the serial slot on either outcome; the caller still receives
      // its rejection. A swallowed SQL error must never turn rollback into success.
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
    // The callback may resume later. It must never issue SQL on the pooled
    // connection after rollback/commit has returned that connection to others.
    open = false;
    signal.removeEventListener("abort", abort);
  }
}
