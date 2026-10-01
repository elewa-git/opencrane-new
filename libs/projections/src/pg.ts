import type { Pool } from "pg";
import type { Db } from "./db.ts";

/** The caller owns the pool, TLS settings and pool error listener. */
export function pgDb(pool: Pool): Db {
  return {
    query: (sql, parameters) => pool.query(sql, parameters),
    async transaction(work) {
      const client = await pool.connect();
      let released = false;
      try {
        await client.query("BEGIN");
        const result = await work({
          query: (sql, parameters) => client.query(sql, parameters),
        });
        await client.query("COMMIT");
        return result;
      } catch (error) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackError) {
          client.release(true);
          released = true;
          throw new AggregateError(
            [error, rollbackError],
            "Projection transaction and rollback failed",
            { cause: rollbackError },
          );
        }
        throw error;
      } finally {
        // release after rollback failure was already handled above.
        if (!released) {
          client.release();
        }
      }
    },
  };
}
