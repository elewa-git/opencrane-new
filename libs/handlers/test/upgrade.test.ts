import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type HandlerName } from "@opencrane/events";
import { event } from "@opencrane/event-store/testing";
import { dispatch, registerHandler, upgradeHandlers } from "../src/index.ts";
import { effect, fixture, until } from "./helpers.ts";

const execute = promisify(execFile);
const oldManifest = JSON.stringify([
  { name: "create-assistant", eventTypes: ["member.joined"] },
  { name: "update-members", eventTypes: ["member.removed"] },
  { name: "update-openfga", eventTypes: ["member.joined", "member.invited"] },
]);

function upgradeTests() {
  let preparedRuntime: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>["runtime"]>>;
  let current: Awaited<ReturnType<typeof fixture>>;
  async function close() {
    if (current) {
      await current.close();
    }
  }
  afterEach(close);

  async function prepare() {
    current = await fixture({ idleTimeoutMillis: 50 });
    await current.append("joined");
    await current.append("role", "member-alice", "member.role_changed");
    await current.append("role-again", "member-alice", "member.role_changed");
    await current.append("owner", "member-bootstrap-owner", "silo.owner_bootstrapped");
    await current.db.query(`CREATE TABLE handler_dispatcher (
      id INTEGER PRIMARY KEY, silo TEXT, manifest TEXT, sequence BIGINT)`);
    await current.db.query("INSERT INTO handler_dispatcher VALUES (1, 'test', $1, 4)",
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
    const runtime = await current.runtime(handlers, { retryLimit: 5 });
    await current.db.query("INSERT INTO handler_receipts VALUES ('update-openfga', 'joined')");
    await current.db.query("INSERT INTO handler_receipts VALUES ('create-assistant', 'joined')");
    await effect(event("joined"), current.db, "update-openfga");
    await effect(event("joined"), current.db, "create-assistant");
    // Keep a receipt for a newly subscribed event to prove backfill honours it too.
    await current.db.query("INSERT INTO handler_receipts VALUES ('seed-model-grants', 'joined')");
    await effect(event("joined"), current.db, "seed-model-grants");
    preparedRuntime = runtime;
    return runtime;
  }

  async function command(...args: string[]) {
    if (!args.includes("--dry-run")) {
      await preparedRuntime.stop();
      await delay(150);
    }
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
    await current.append("tail", "member-alice");
    const preview = await command("--dry-run");
    expect(preview.stdout).toContain("seed-model-grants");
    expect(preview.stdout).toContain("member.joined");
    expect(preview.stdout).toContain('"eventCount":2');
    await command("--confirm-writers-stopped");
    const upgraded = await snapshot();
    await command("--confirm-writers-stopped");
    expect(await snapshot()).toEqual(upgraded);
    await runtime.start();
    await runtime.work(1);
    async function applied() {
      return (await current.effects()).length === 9;
    }
    await until(applied);
    const effects = await current.effects();
    const expected = ["create-assistant:joined", "create-assistant:owner", "seed-model-grants:joined",
      "seed-model-grants:owner", "seed-ownership:owner", "update-openfga:joined",
      "update-openfga:owner", "update-openfga:role", "update-openfga:role-again"];
    // Skip the newly subscribed event whose receipt already records its effect.
    function key(row: typeof effects[number]) {
      return `${row.handler}:${row.event_id}`;
    }
    const appliedKeys = effects.map(key);
    const sortedKeys = [...appliedKeys];
    sortedKeys.sort();
    expected.sort();
    expect(sortedKeys).toEqual(expected);
    expect(appliedKeys.indexOf("update-openfga:role"))
      .toBeLessThan(appliedKeys.indexOf("update-openfga:role-again"));
    void current.startDispatch(runtime);
    await current.checkpoint(5);
    async function tailApplied() {
      return (await current.effects()).length === 12;
    }
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
    await runtime.start();
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
    function observeFailure() {
      return undefined;
    }
    void task.catch(observeFailure);
    try {
      function warned() {
        return Promise.resolve(log.mock.calls.length > 0);
      }
      await until(warned, 2000);
      const message = JSON.stringify(log.mock.calls);
      expect(message).toContain("npm run ops -- upgrade-handlers");
      expect(message).toContain("--dry-run");
      expect(message).toContain("drain");
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
  async function unfinishedJobs(state: string) {
    const runtime = await prepare();
    await runtime.enqueue(runtime.options.handlers[0]!, event('pending'), current.db);
    await current.db.query("UPDATE pgboss.job SET state = $1", [state]);
    const before = await snapshot();
    await expect(command('--dry-run')).rejects.toThrow('unfinished');
    await expect(command('--confirm-writers-stopped')).rejects.toThrow('unfinished');
    expect(await snapshot()).toEqual(before);
  }
  it.each(['created', 'retry', 'active'])(
    'refuses unfinished %s jobs in both modes', unfinishedJobs);

  async function failedJobs() {
    const runtime = await prepare();
    await runtime.enqueue(runtime.options.handlers[0]!, event('failed'), current.db);
    await current.db.query("UPDATE pgboss.job SET state = 'failed'");
    const preview = await command('--dry-run');
    expect(preview.stdout).toContain('failedJobs');
    expect(preview.stdout).toContain('update-openfga');
    await command('--confirm-writers-stopped');
    const result = await current.db.query("SELECT id FROM pgboss.job WHERE state = 'failed'");
    expect(result.rows).toHaveLength(1);
  }
  it('reports failed jobs and lets an upgrade proceed', failedJobs);

  async function connectedSession() {
    await prepare();
    const session = await current.pool.connect();
    try {
      await expect(command('--confirm-writers-stopped')).rejects.toThrow('other database session');
      await command('--dry-run');
    } finally {
      session.release();
    }
  }
  it('refuses even an idle old worker connection while dry run remains available', connectedSession);

  async function previewWhileLocked() {
    const runtime = await prepare();
    const stop = new AbortController();
    const task = dispatch(current.nats.dispatcherConnection, runtime, stop.signal);
    try {
      await delay(100);
      await command('--dry-run');
    } finally {
      stop.abort();
      await task;
    }
  }
  it('takes no dispatcher lock during dry run', previewWhileLocked);

  async function removedHandlerJobs() {
    await prepare();
    const rows = await current.db.query("SELECT name FROM pgboss.queue WHERE name = 'update-members'");
    expect(rows.rows).toEqual([]);
    await preparedRuntime.boss.createQueue('update-members');
    await preparedRuntime.boss.send('update-members', event('removed-handler-job'));
    await expect(command('--confirm-writers-stopped')).rejects.toThrow('unfinished');
  }
  it('checks jobs belonging to a removed handler too', removedHandlerJobs);

  async function createsNewQueue() {
    await prepare();
    await preparedRuntime.boss.deleteQueue('seed-ownership');
    await preparedRuntime.boss.deleteQueue('seed-ownership-dead');
    await command('--confirm-writers-stopped');
    const queued = await current.db.query("SELECT id FROM pgboss.job WHERE name = 'seed-ownership'");
    expect(queued.rows).toHaveLength(1);
  }
  it('creates a new handler queue before inserting its history', createsNewQueue);

  async function removalNeedsNoScan() {
    const runtime = await prepare();
    const manifest = JSON.parse(oldManifest) as { name: string; eventTypes: string[] }[];
    // Store all current subscriptions plus a removed handler.
    for (const handler of runtime.options.handlers) {
      const subscription = { name: handler.name, eventTypes: [...handler.eventTypes] };
      manifest.push(subscription);
    }
    await current.db.query('UPDATE handler_dispatcher SET manifest = $1', [JSON.stringify(manifest)]);
    await runtime.stop();
    function noRead(): AsyncIterable<never> {
      throw new Error('Removal must not scan history');
    }
    const source = { head: async () => 4, subscribe: noRead };
    await upgradeHandlers(runtime, source);
  }
  it('does not read history when subscriptions are only removed', removalNeedsNoScan);

  async function resumesSavedChunk() {
    const runtime = await prepare();
    const history = [];
    for (let index = 0; index < 260; index++) {
      history.push(event(`history-${index}`, 'member-alice', 'member.role_changed'));
    }
    await current.nats.seed(history);
    await current.db.query('UPDATE handler_dispatcher SET sequence = 264');
    await runtime.stop();
    const original = current.nats.store.subscribe.bind(current.nats.store);
    async function* crashAfterChunk(from: number, signal?: AbortSignal) {
      for await (const row of original(from, signal)) {
        if (row.sequence > 256) {
          throw new Error('Simulated process crash');
        }
        yield row;
      }
    }
    const crashing = { head: current.nats.store.head.bind(current.nats.store),
      subscribe: crashAfterChunk };
    await expect(upgradeHandlers(runtime, crashing)).rejects.toThrow('Simulated process crash');
    const progress = await current.db.query('SELECT sequence FROM handler_upgrade');
    expect(Number(progress.rows[0]?.['sequence'])).toBe(256);
    const beforeResume = await current.db.query('SELECT id FROM pgboss.job');
    expect(beforeResume.rows.length).toBeGreaterThan(200);
    const requested: number[] = [];
    function resumed(from: number, signal?: AbortSignal) {
      requested.push(from);
      return original(from, signal);
    }
    const source = { head: crashing.head, subscribe: resumed };
    await upgradeHandlers(runtime, source);
    expect(requested[0]).toBe(257);
    const jobs = await current.db.query("SELECT data->>'id' AS event_id FROM pgboss.job " +
      "WHERE name = 'update-openfga'");
    expect(jobs.rows).toHaveLength(263);
    expect((await current.db.query('SELECT * FROM handler_upgrade')).rows).toEqual([]);
  }
  it('keeps committed chunks after a crash and resumes without duplicate jobs', resumesSavedChunk);

  async function retriesReadTimeout() {
    const runtime = await prepare();
    await runtime.stop();
    const original = current.nats.store.subscribe.bind(current.nats.store);
    let attempts = 0;
    async function* stalled(from: number, signal?: AbortSignal) {
      attempts += 1;
      if (attempts === 1) {
        await delay(1100);
        return;
      }
      yield* original(from, signal);
    }
    const source = { head: current.nats.store.head.bind(current.nats.store), subscribe: stalled };
    await upgradeHandlers(runtime, source);
    expect(attempts).toBe(2);
    expect((await snapshot()).jobs).toHaveLength(7);
  }
  it('backs off and retries a transient history timeout', retriesReadTimeout);

  async function operatesFailedJobs() {
    const runtime = await prepare();
    await runtime.enqueue(runtime.options.handlers[0]!, event('failed-original'), current.db);
    await current.db.query("UPDATE pgboss.job SET state = 'failed'");
    const failed = await current.db.query<{ id: string }>('SELECT id FROM pgboss.job');
    const jobId = failed.rows[0]!.id;
    const env = { ...process.env, DATABASE_URL: current.connectionString };
    const listed = await execute('npm', ['run', 'ops', '--', 'jobs'], { env });
    expect(listed.stdout).toContain(jobId);
    await execute('npm', ['run', 'ops', '--', 'jobs', '--cancel', jobId], { env });
    const result = await current.db.query<{ state: string }>('SELECT state FROM pgboss.job');
    expect(result.rows[0]?.state).toBe('cancelled');
    await expect(execute('npm', ['run', 'ops', '--', 'jobs', '--cancel', jobId], { env }))
      .rejects.toThrow('failed job');
    expect((await current.db.query('SELECT * FROM handler_receipts')).rows).toHaveLength(3);
  }
  it('lists and cancels one failed original without changing receipts', operatesFailedJobs);

}
describe.skipIf(!process.env["PG_TEST_URL"])("handler subscription upgrade / real services", upgradeTests);
