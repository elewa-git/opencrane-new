// Real process barriers surround SQL commit, without replacing NATS or pg-boss.
import { Pool } from "pg";
import { connectEventStore, connectNats } from "@opencrane/event-store";
import { members, ProjectionRunner, pgDb, type Db, type Query } from "@opencrane/projections";
import { HandlerRuntime, registerHandler, dispatch, upgradeHandlers } from "../src/index.ts";
import { effect, logger } from "./helpers.ts";
import { sessionDiagnostics } from "./session-diagnostics.ts";

const mode = process.env["CRASH_MODE"] ?? "";
const poolOptions = {
  connectionString: process.env["PG_TEST_URL"],
  application_name: `handlers-crash-${mode}`,
};
const pool = new Pool(poolOptions);
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
        query: async (sql, values) => {
          if (mode === "dispatcher-after-ack" && sql.startsWith("UPDATE handler_dispatcher") && values?.[0] === 2) {
            await barrier();
          }
          if (
            sql.startsWith(
              mode.startsWith("dispatcher")
                ? "UPDATE handler_dispatcher"
                : mode.startsWith("projection") ? "UPDATE projection_checkpoints" : "INSERT INTO handler_receipts",
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
function upgradeCrashDb(database: Db): Db {
  async function lock<T>(name: string, work: (locked: Db) => Promise<T>): Promise<T> {
    async function run(locked: Db) {
      return work(upgradeCrashDb(locked));
    }
    return database.lock!(name, run);
  }
  async function transaction<T>(work: (tx: Query) => Promise<T>): Promise<T> {
    let published = false;
    async function run(tx: Query) {
      async function query<Row extends Record<string, unknown>>(sql: string, values?: unknown[]) {
        const result = await tx.query<Row>(sql, values);
        function isClientSession(row: Row) {
          return row['backend_type'] === 'client backend';
        }
        if (sql.startsWith('SELECT backend_type FROM pg_stat_activity') &&
          result.rows.some(isClientSession)) {
          const sessions = await sessionDiagnostics(tx);
          const diagnostic = { mode, otherDatabaseSessions: sessions };
          console.error(JSON.stringify(diagnostic));
        }
        if (sql.startsWith('UPDATE pgboss.job AS job') && mode === 'upgrade-inside-chunk') {
          await barrier();
        }
        if (sql.startsWith('UPDATE handler_dispatcher SET manifest')) {
          published = true;
          if (mode === 'upgrade-inside-publication') {
            await barrier();
          }
        }
        return result;
      }
      const interrupted: Query = { query };
      return work(interrupted);
    }
    const result = await database.transaction(run);
    if (published && mode === 'upgrade-after-publication') {
      await barrier();
    }
    return result;
  }
  return { ...database, transaction, lock };
}

if (mode.startsWith("dispatcher")) {
  db.lock = base.lock!.bind(base);
}
if (mode.startsWith("upgrade")) {
  const { store } = await connectEventStore();
  const subscribe = store.subscribe.bind(store);
  async function* stopAfterChunk(from: number, signal?: AbortSignal) {
    if (from > 256 && mode === "upgrade-after-chunk") {
      await barrier();
    }
    yield* subscribe(from, signal);
  }
  const source = { head: store.head.bind(store), subscribe: stopAfterChunk };
  const names = ['update-openfga', 'seed-ownership', 'confirm-ownership', 'seed-model-grants',
    'seed-provider-default', 'create-assistant', 'claim-computer', 'cleanup-departure',
    'stop-budget-turns', 'prepare-gateway-configuration', 'settle-budget'] as const;
  function subscription(name: typeof names[number]) {
    return registerHandler(name, effect);
  }
  const handlers = names.map(subscription);
  const upgradeDb = upgradeCrashDb(base);
  const runtime = new HandlerRuntime({ db: upgradeDb, logger, silo: 'test', handlers });
  await upgradeHandlers(runtime, source);
} else if (mode.startsWith("projection")) {
  const { store } = await connectEventStore();
  const runner = new ProjectionRunner(db, store, logger);
  await runner.initialise(members);
  await runner.run(members);
} else {
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
    const connection = await connectNats();
    await dispatch(connection, runtime, new AbortController().signal);
  } else {
    await runtime.work();
  }

}
