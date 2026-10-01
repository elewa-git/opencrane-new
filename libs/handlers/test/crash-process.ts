// Real process barriers surround SQL commit, without replacing NATS or pg-boss.
import { Pool } from "pg";
import { connect } from "@nats-io/transport-node";
import { pgDb, type Db } from "@opencrane/projections";
import { HandlerRuntime, registerHandler, dispatch } from "../src/index.ts";
import { effect, logger } from "./helpers.ts";

const mode = process.env["CRASH_MODE"] ?? "";
const pool = new Pool({ connectionString: process.env["PG_TEST_URL"] });
const base = pgDb(pool);
async function barrier() {
  process.send?.("at-crash-boundary");
  await new Promise<void>(() => {
    /* Parent kills this process. */
  });
}
const db: Db = {
  query: (sql, values) => base.query(sql, values),
  async transaction(work) {
    let target = false;
    const result = await base.transaction(async (tx) => {
      const result = await work({
        query: (sql, values) => {
          if (
            sql.startsWith(
              mode.startsWith("dispatcher")
                ? "UPDATE handler_dispatcher"
                : "INSERT INTO handler_receipts",
            )
          ) {
            target = true;
          }
          return tx.query(sql, values);
        },
      });
      if (target && mode.endsWith("before-commit")) {
        await barrier();
      }
      return result;
    });
    if (target && mode.endsWith("after-commit")) {
      await barrier();
    }
    return result;
  },
};
const runtime = new HandlerRuntime({
  db,
  logger,
  silo: "test",
  handlers: [
    registerHandler("update-members", effect),
    ...(mode.startsWith("dispatcher")
      ? [
          registerHandler("update-openfga", (event, tx) =>
            effect(event, tx, "update-openfga"),
          ),
        ]
      : []),
  ],
  retryLimit: 1,
  expireInSeconds: 1,
});
await runtime.start();
if (mode.startsWith("dispatcher")) {
  const connection = await connect({
    servers: process.env["NATS_TEST_URL"] ?? "",
  });
  await dispatch(connection, runtime, new AbortController().signal);
} else {
  await runtime.work();
}
