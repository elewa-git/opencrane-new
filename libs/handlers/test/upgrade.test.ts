import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type HandlerName } from "@opencrane/events";
import { event } from "@opencrane/event-store/testing";
import { dispatch, registerHandler } from "../src/index.ts";
import { effect, fixture, until } from "./helpers.ts";

const execute = promisify(execFile);
const oldManifest = JSON.stringify([
  { name: "create-assistant", eventTypes: ["member.joined"] },
  { name: "update-members", eventTypes: ["member.removed"] },
  { name: "update-openfga", eventTypes: ["member.joined", "member.invited"] },
]);

function upgradeTests() {
  let current: Awaited<ReturnType<typeof fixture>>;
  async function close() {
    if (current) {
      await current.close();
    }
  }
  afterEach(close);

  async function prepare() {
    current = await fixture();
    await current.append("joined");
    await current.append("role", "member-alice", "member.role_changed");
    await current.append("owner", "member-bootstrap-owner", "silo.owner_bootstrapped");
    await current.db.query(`CREATE TABLE handler_dispatcher (
      id INTEGER PRIMARY KEY, silo TEXT, manifest TEXT, sequence BIGINT)`);
    await current.db.query("INSERT INTO handler_dispatcher VALUES (1, 'test', $1, 3)",
      [oldManifest]);
    const names: HandlerName[] = ["update-openfga", "seed-ownership", "seed-model-grants",
      "create-assistant", "claim-computer", "settle-budget"];
    function testHandler(name: HandlerName) {
      async function apply(event: Parameters<typeof effect>[0], tx: Parameters<typeof effect>[1]) {
        await effect(event, tx, name);
      }
      return registerHandler(name, apply);
    }
    const handlers = names.map(testHandler);
    const runtime = await current.runtime(handlers);
    await current.db.query("INSERT INTO handler_receipts VALUES ('update-openfga', 'joined')");
    await current.db.query("INSERT INTO handler_receipts VALUES ('create-assistant', 'joined')");
    await effect(event("joined"), current.db, "update-openfga");
    await effect(event("joined"), current.db, "create-assistant");
    // Keep a receipt for a newly subscribed event to prove backfill honours it too.
    await current.db.query("INSERT INTO handler_receipts VALUES ('seed-model-grants', 'joined')");
    await effect(event("joined"), current.db, "seed-model-grants");
    return runtime;
  }

  async function command(...args: string[]) {
    const env = { ...process.env, ...current.nats.env("projection"),
      DATABASE_URL: current.connectionString, SILO_ID: "test", MODEL_DECISION_URL: "http://unused" };
    return execute("npm", ["run", "ops", "--", "upgrade-handlers", ...args], { env });
  }

  async function snapshot() {
    const state = await current.db.query("SELECT * FROM handler_dispatcher");
    const receipts = await current.db.query("SELECT * FROM handler_receipts ORDER BY handler, event_id");
    const jobs = await current.db.query("SELECT * FROM pgboss.job ORDER BY name, id");
    return { state: state.rows, receipts: receipts.rows, jobs: jobs.rows };
  }

  async function backfill() {
    const runtime = await prepare();
    const preview = await command("--dry-run");
    expect(preview.stdout).toContain("seed-model-grants");
    expect(preview.stdout).toContain("member.joined");
    expect(preview.stdout).toContain('"eventCount":2');
    await command("--confirm-writers-stopped");
    const upgraded = await snapshot();
    await command("--confirm-writers-stopped");
    expect(await snapshot()).toEqual(upgraded);
    await runtime.work(1);
    async function applied() {
      return (await current.effects()).length === 8;
    }
    await until(applied);
    const effects = await current.effects();
    const expected = ["create-assistant:joined", "create-assistant:owner", "seed-model-grants:joined",
      "seed-model-grants:owner", "seed-ownership:owner", "update-openfga:joined",
      "update-openfga:owner", "update-openfga:role"];
    // Skip the newly subscribed event whose receipt already records its effect.
    function key(row: typeof effects[number]) { return `${row.handler}:${row.event_id}`; }
    expect(effects.map(key).sort()).toEqual(expected.sort());
    void current.startDispatch(runtime);
    await current.append("tail", "member-alice");
    await current.checkpoint(4);
    async function tailApplied() { return (await current.effects()).length === 11; }
    await until(tailApplied);
  }
  it("backfills new subscriptions once, preserves old effects and resumes the durable consumer", backfill);

  async function dryRun() {
    await prepare();
    const before = await snapshot();
    await command("--dry-run");
    expect(await snapshot()).toEqual(before);
    await expect(command()).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  }
  it("dry run and a missing stop confirmation change nothing", dryRun);

  async function locked() {
    const runtime = await prepare();
    await command("--confirm-writers-stopped");
    void current.startDispatch(runtime);
    async function dispatcherLocked() {
      const locks = await current.db.query("SELECT * FROM pg_locks WHERE locktype = 'advisory'");
      return locks.rows.length > 0;
    }
    await until(dispatcherLocked);
    await expect(command("--confirm-writers-stopped")).rejects.toThrow("dispatcher is running");
  }
  it("refuses an upgrade while the dispatcher holds its lock, even for an equal manifest", locked);

  async function startupMessage() {
    const runtime = await prepare();
    const log = vi.spyOn(runtime.options.logger, "error");
    const stop = new AbortController();
    const ready = vi.fn();
    const task = dispatch(current.nats.dispatcherConnection, runtime, stop.signal, ready);
    function observeFailure() { return undefined; }
    void task.catch(observeFailure);
    try {
      async function warned() { return log.mock.calls.length > 0; }
      await until(warned, 2000);
      const message = JSON.stringify(log.mock.calls);
      expect(message).toContain("npm run ops -- upgrade-handlers");
      expect(message).toContain("update-openfga");
      expect(message).toContain("member.role_changed");
      expect(message).toContain("member.invited");
      expect(message).toContain("update-members");
      expect(ready).not.toHaveBeenCalled();
      expect((await snapshot()).jobs).toHaveLength(0);
    } finally {
      stop.abort();
      await task;
    }
  }
  it("startup reports exact subscription changes and stays stopped before starting workers", startupMessage);
}
describe.skipIf(!process.env["PG_TEST_URL"])("handler subscription upgrade / real services", upgradeTests);
