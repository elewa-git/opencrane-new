import type { PGlite } from "@electric-sql/pglite";
import type { Db } from "./db.ts";

/** The caller owns the engine and closes it after the runner stops. */
export function pgliteDb(engine: PGlite): Db {
  const db: Db = {
    query: (sql, parameters) => engine.query(sql, parameters),
    transaction: (work) =>
      engine.transaction((transaction) =>
        work({
          query: (sql, parameters) => transaction.query(sql, parameters),
        }),
      ),
    lock: (_name, work) => work(db),
  };
  return db;
}
