// Real process barriers surround SQL commit, without replacing NATS or pg-boss.
import { Pool } from "pg";
import { connectEventStore, connectNats } from "@opencrane/event-store";
import { members, ProjectionRunner, pgDb, type Db, type Query } from "@opencrane/projections";
import { HandlerRuntime, registerHandler, dispatch, upgradeHandlers } from "../src/index.ts";
import { effect, logger } from "./helpers.ts";
import { sessionDiagnostics } from "./session-diagnostics.ts";
import { upgradeFixtureHandlerNames } from './upgrade-fixture-handlers.ts';

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
function crashStatement(): string {
  if (mode.startsWith('dispatcher')) {
    return 'UPDATE handler_dispatcher';
  }
  if (mode.startsWith('projection')) {
    return 'UPDATE projection_checkpoints';
  }
  return 'INSERT INTO handler_receipts';
}

function crashDb(database: Db): Db {
  function query<Row extends Record<string, unknown>>(sql: string, values?: unknown[]) {
    return database.query<Row>(sql, values);
  }
  async function transaction<T>(work: (tx: Query) => Promise<T>): Promise<T> {
    let target = false;
    async function run(tx: Query) {
      async function query<Row extends Record<string, unknown>>(sql: string, values?: unknown[]) {
        const awaitingSecondCheckpoint = mode === 'dispatcher-after-ack' &&
          sql.startsWith('UPDATE handler_dispatcher') && values?.[0] === 2;
        if (awaitingSecondCheckpoint) {
          await barrier();
        }
        if (sql.startsWith(crashStatement())) {
          target = true;
        }
        return tx.query<Row>(sql, values);
      }
      const result = await work({ query });
      if (target && mode.endsWith('before-commit')) {
        await barrier();
      }
      return result;
    }
    const result = await database.transaction(run);
    if (target && mode.endsWith('after-commit')) {
      await barrier();
    }
    return result;
  }
  const db: Db = { query, transaction };
  if (mode.startsWith('dispatcher')) {
    async function lock<T>(name: string, work: (locked: Db) => Promise<T>): Promise<T> {
      async function run(locked: Db) {
        // Keep the same crash boundaries when dispatch uses its held connection.
        return work(crashDb(locked));
      }
      return database.lock!(name, run);
    }
    db.lock = lock;
  }
  return db;
}
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

const db = crashDb(base);
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
  async function guardedEffect(...args: Parameters<typeof effect>) {
    const effectUrl = process.env['CRASH_EFFECT_URL'];
    if (effectUrl) {
      await fetch(effectUrl);
    }
    await effect(...args);
  }
  function subscription(name: typeof upgradeFixtureHandlerNames[number]) {
    return registerHandler(name, guardedEffect);
  }
  const handlers = upgradeFixtureHandlerNames.map(subscription);
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
