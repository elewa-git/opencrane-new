import { randomUUID } from "node:crypto";
import { execFile, fork, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import { createLogger } from "@opencrane/observability";
import { pgDb, type Query } from "@opencrane/projections";
import type { EventEnvelope } from "@opencrane/events";
import { event, natsFixture } from "@opencrane/event-store/testing";
import { HandlerRuntime, dispatch, type Handler } from "../src/index.ts";

export const logger = createLogger("handler-tests", { level: "silent" });
export async function effect(
  event: EventEnvelope,
  tx: Query,
  handler = "update-members",
) {
  await tx.query(
    "INSERT INTO handler_effects (handler, event_id, stream) VALUES ($1, $2, $3)",
    [handler, event.id, event.subject],
  );
}
export async function until(check: () => Promise<boolean>, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for durable outcome");
    }
    await delay(25);
  }
}
export async function fixture(options: { idleTimeoutMillis?: number; max?: number } = {}) {
  const url = new URL(process.env["PG_TEST_URL"] ?? "");
  const admin = new Pool({ connectionString: url.href });
  const name = `handlers_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE DATABASE ${name}`);
  url.pathname = `/${name}`;
  const connectionString = url.href;
  const poolOptions = {
    connectionString,
    application_name: "handlers-test-fixture",
    ...options,
  };
  const pool = new Pool(poolOptions);
  const db = pgDb(pool);
  await db.query(`CREATE TABLE handler_effects (
    ordinal SERIAL, handler TEXT, event_id TEXT, stream TEXT)`);
  const nats = await natsFixture({ provision: false });
  await promisify(execFile)(process.execPath,
    ["--experimental-strip-types", "libs/handlers/src/provision.ts"],
    { env: { ...process.env, ...nats.env(), NATS_REPLICAS: "1" } });
  const runtimes: HandlerRuntime[] = [];
  const children: ChildProcess[] = [];
  const dispatchers: { controller: AbortController; task: Promise<void> }[] =
    [];
  async function closeIdleConnections() {
    const backendPids: number[] = [];
    while (pool.idleCount > 0) {
      const client = await pool.connect();
      try {
        const identity = await client.query<{ pid: number }>(
          "SELECT pg_backend_pid() AS pid",
        );
        backendPids.push(identity.rows[0]!.pid);
      } finally {
        client.release(true);
      }
    }
    async function idleConnectionsClosed() {
      const connections = await admin.query(
        "SELECT pid FROM pg_stat_activity WHERE pid = ANY($1::int[])",
        [backendPids],
      );
      return connections.rows.length === 0;
    }
    // Wait for PostgreSQL to finish closing the clients before another process starts an upgrade.
    await until(idleConnectionsClosed);
  }
  async function waitForConnectionsClosed() {
    await closeIdleConnections();
    async function closed() {
      const connections = await admin.query(
        "SELECT pid FROM pg_stat_activity WHERE datname = $1",
        [name],
      );
      return connections.rows.length === 0;
    }
    await until(closed);
  }
  return {
    db,
    pool,
    nats,
    connectionString,
    waitForConnectionsClosed,
    closeIdleConnections,
    async runtime(
      handlers: Handler[],
      options: { retryLimit?: number; expireInSeconds?: number } = {},
    ) {
      const runtime = new HandlerRuntime({
        db,
        logger,
        silo: "test",
        handlers,
        retryLimit: 1,
        ...options,
      });
      runtimes.push(runtime);
      await runtime.start();
      return runtime;
    },
    startDispatch(runtime: HandlerRuntime) {
      const controller = new AbortController();
      const task = dispatch(nats.dispatcherConnection, runtime, controller.signal);
      // Keep rejection observed while assertions run; close still reports it.
      void task.catch(() => undefined);
      dispatchers.push({ controller, task });
      return task;
    },
    async append(id: string, stream = "member-alice", type = "member.joined") {
      const history = [];
      for await (const stored of nats.store.readStream(stream)) {
        history.push(stored);
      }
      const result = await nats.store.append({
        event: event(id, stream, type),
        expectedSequence: history.at(-1)?.sequence ?? 0,
      });
      if (result.status !== "appended") {
        throw new Error(`Append failed: ${result.status}`);
      }
      return result.sequence;
    },
    async effects() {
      return (
        await db.query<{ handler: string; event_id: string; stream: string }>(
          "SELECT * FROM handler_effects ORDER BY ordinal",
        )
      ).rows;
    },
    async checkpoint(sequence: number) {
      await until(async () => {
        const exists = await db.query<{ name: string | null }>(
          "SELECT to_regclass('handler_dispatcher')::text AS name",
        );
        if (!exists.rows[0]?.name) {
          return false;
        }
        const row = await db.query<{ sequence: string }>(
          "SELECT sequence FROM handler_dispatcher",
        );
        return Number(row.rows[0]?.sequence) === sequence;
      });
    },
    async crash(mode: string) {
      const child = fork(new URL("./crash-process.ts", import.meta.url), [], {
        execArgv: ["--experimental-strip-types"],
        env: {
          ...process.env,
          PG_TEST_URL: connectionString,
          ...nats.env((mode.startsWith("projection") || mode.startsWith("upgrade")) ? "projection" : "dispatcher"),
          CRASH_MODE: mode,
        },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
      children.push(child);
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`Crash barrier timed out: ${stderr}`)),
          15_000,
        );
        child.once("message", () => {
          clearTimeout(timer);
          resolve();
        });
        child.once("exit", () => {
          clearTimeout(timer);
          reject(new Error(`Child exited: ${stderr}`));
        });
        child.once("error", reject);
      });
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
      async function childConnectionsClosed() {
        const connections = await admin.query(
          "SELECT pid FROM pg_stat_activity WHERE datname = $1 AND application_name = $2",
          [name, `handlers-crash-${mode}`],
        );
        return connections.rows.length === 0;
      }
      // Wait for the killed child's transactions to end before checking or rebuilding their work.
      await until(childConnectionsClosed);
    },
    async close() {
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) {
          const exited = once(child, "exit");
          child.kill("SIGKILL");
          await exited;
        }
      }
      for (const { controller } of dispatchers) {
        controller.abort();
      }
      const results = await Promise.allSettled(
        dispatchers.map(({ task }) => task),
      );
      // Stop every runtime before closing their shared pool, even if one stop fails.
      results.push(...await Promise.allSettled(runtimes.map((runtime) => runtime.stop())));
      results.push(...await Promise.allSettled([nats.close(), pool.end()]));
      await waitForConnectionsClosed();
      await admin.query(`DROP DATABASE ${name}`);
      await admin.end();
      for (const result of results) {
        if (
          result.status === "rejected" &&
          !(
            result.reason instanceof DOMException &&
            result.reason.name === "AbortError"
          )
        ) {
          throw result.reason;
        }
      }
    },
  };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
