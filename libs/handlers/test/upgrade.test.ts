import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import type { PoolClient } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type HandlerName } from "@opencrane/events";
import { event } from "@opencrane/event-store/testing";
import { dispatch, HandlerRuntime, registerHandler, upgradeHandlers } from "../src/index.ts";
import { scanUpgrade } from "../src/upgrade-scan.ts";
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
      "seed-provider-default", "create-assistant", "claim-computer", "settle-budget"];
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
    const manifest = [{ name: 'update-members', eventTypes: ['member.removed'] }];
    // Store all current subscriptions plus a removed handler.
    for (const handler of runtime.options.handlers) {
      const subscription = { name: handler.name, eventTypes: [...handler.eventTypes] };
      manifest.push(subscription);
    }
    await current.db.query('UPDATE handler_dispatcher SET manifest = $1', [JSON.stringify(manifest)]);
    await runtime.stop();
    await current.waitForConnectionsClosed();
    function noRead(): AsyncIterable<never> {
      throw new Error('Removal must not scan history');
    }
    function head() {
      return Promise.resolve(4);
    }
    const source = { head, subscribe: noRead };
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
    await current.waitForConnectionsClosed();
    const original = current.nats.store.subscribe.bind(current.nats.store);
    await delay(150);
    await current.crash('upgrade-after-chunk');
    const progress = await current.db.query('SELECT sequence FROM handler_upgrade');
    expect(Number(progress.rows[0]?.['sequence'])).toBe(256);
    const beforeResume = await current.db.query('SELECT id FROM pgboss.job');
    expect(beforeResume.rows.length).toBeGreaterThan(200);
    const requested: number[] = [];
    function resumed(from: number, signal?: AbortSignal) {
      requested.push(from);
      return original(from, signal);
    }
    const source = { head: current.nats.store.head.bind(current.nats.store), subscribe: resumed };
    await current.waitForConnectionsClosed();
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
    await current.waitForConnectionsClosed();
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

  async function invalidManifest(manifest: string) {
    await prepare();
    await current.db.query('UPDATE handler_dispatcher SET manifest = $1', [manifest]);
    const before = await snapshot();
    await expect(command('--dry-run')).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  }
  it.each(['invalid-json', '{}', '[{"name":"update-openfga","eventTypes":[42]}]'])(
    'refuses malformed dispatcher manifest %s without changing state', invalidManifest);

  async function invalidCheckpoint(sequence: number) {
    await prepare();
    await current.db.query('UPDATE handler_dispatcher SET sequence = $1', [sequence]);
    const before = await snapshot();
    await expect(command('--dry-run')).rejects.toThrow('checkpoint is outside');
    expect(await snapshot()).toEqual(before);
  }
  it.each([-1, 5])('refuses a checkpoint outside saved history (%s)', invalidCheckpoint);

  async function invalidDispatcherState(missing: boolean) {
    await prepare();
    if (missing) {
      await current.db.query('DELETE FROM handler_dispatcher');
    } else {
      await current.db.query("UPDATE handler_dispatcher SET silo = 'other'");
    }
    const before = await snapshot();
    await expect(command('--dry-run')).rejects.toThrow('state missing or silo mismatch');
    expect(await snapshot()).toEqual(before);
  }
  it.each([false, true])('refuses missing or foreign dispatcher state (missing: %s)',
    invalidDispatcherState);

  async function missingDatabaseLock() {
    const runtime = await prepare();
    await runtime.stop();
    const database = { query: current.db.query.bind(current.db),
      transaction: current.db.transaction.bind(current.db) };
    const options = { ...runtime.options, db: database };
    const unlocked = new HandlerRuntime(options);
    await expect(upgradeHandlers(unlocked, current.nats.store))
      .rejects.toThrow('requires a database lock');
    expect((await snapshot()).jobs).toEqual([]);
  }
  it('refuses a database adapter without a lasting lock', missingDatabaseLock);

  async function invalidBatch(missing: boolean) {
    const runtime = await prepare();
    await runtime.stop();
    await current.waitForConnectionsClosed();
    let scanning = runtime;
    if (missing) {
      const options = { ...runtime.options, handlers: [] };
      scanning = new HandlerRuntime(options);
    } else {
      const insert = runtime.boss.insert.bind(runtime.boss);
      async function fewerIds(...args: Parameters<typeof insert>) {
        const ids = await insert(...args);
        return ids?.slice(1) ?? null;
      }
      vi.spyOn(runtime.boss, 'insert').mockImplementation(fewerIds);
    }
    const changes = [{ handler: 'update-openfga', addedTypes: ['member.role_changed'],
      removedTypes: [], eventCount: 0 }];
    let message = 'Handler batch enqueue refused';
    if (missing) {
      message = 'Backfill handler missing';
    }
    await expect(scanUpgrade(scanning, current.nats.store, changes, 4,
      'target-manifest', oldManifest, undefined, false)).rejects.toThrow(message);
    expect((await snapshot()).jobs).toEqual([]);
    const progress = await current.db.query('SELECT sequence, jobs FROM handler_upgrade');
    expect(progress.rows).toEqual([{ sequence: '0', jobs: '0' }]);
  }
  it.each([false, true])('rolls back an incomplete job batch (handler missing: %s)', invalidBatch);

  async function sessionAppearsDuringScan(betweenChunks: boolean) {
    const runtime = await prepare();
    let target = 4;
    if (betweenChunks) {
      const history = [];
      for (let index = 0; index < 253; index++) {
        history.push(event(`later-history-${index}`, 'member-alice', 'member.role_changed'));
      }
      await current.nats.seed(history);
      target = 257;
      await current.db.query('UPDATE handler_dispatcher SET sequence = $1', [target]);
    }
    await runtime.stop();
    await current.waitForConnectionsClosed();
    const subscribe = current.nats.store.subscribe.bind(current.nats.store);
    let session: PoolClient | undefined;
    let sessionPid: number | undefined;
    async function* reconnects(from: number, signal?: AbortSignal) {
      session ??= await current.pool.connect();
      const identity = await session.query<{ pid: number }>(
        'SELECT pg_backend_pid() AS pid');
      sessionPid = identity.rows[0]?.pid;
      yield* subscribe(from, signal);
    }
    const head = current.nats.store.head.bind(current.nats.store);
    const source = { head, subscribe: reconnects };
    try {
      const upgrade = upgradeHandlers(runtime, source);
      async function captureUpgradeError() {
        try {
          await upgrade;
          return undefined;
        } catch (error) {
          return error;
        }
      }
      const upgradeOutcome = captureUpgradeError();
      async function reconnectSessionIsVisible() {
        if (sessionPid === undefined) {
          return false;
        }
        const result = await current.db.query(
          'SELECT pid FROM pg_stat_activity WHERE pid = $1', [sessionPid]);
        return result.rows.length === 1;
      }
      await until(reconnectSessionIsVisible);
      const error = await upgradeOutcome;
      expect(error).toBeInstanceOf(Error);
      if (!(error instanceof Error)) {
        throw new Error('Expected the upgrade to reject after the session reconnected');
      }
      expect(error.message).toContain('other database sessions');
      const progress = await current.db.query('SELECT sequence FROM handler_upgrade');
      expect(Number(progress.rows[0]?.['sequence'])).toBe(Math.min(target, 256));
      const state = await current.db.query('SELECT manifest FROM handler_dispatcher');
      expect(state.rows[0]?.['manifest']).toBe(oldManifest);
      const released = await current.db.query(
        "SELECT id FROM pgboss.job WHERE start_after <> 'infinity'");
      expect(released.rows).toEqual([]);
    } finally {
      session?.release();
    }
  }
  it.each([false, true])('rechecks sessions before publication and between chunks (%s)',
    sessionAppearsDuringScan);

  async function parkedJobsCannotRun() {
    const runtime = await prepare();
    await runtime.stop();
    await current.waitForConnectionsClosed();
    await current.crash('upgrade-inside-publication');
    await runtime.start();
    const before = await current.effects();
    await runtime.work(1);
    const attempted = await runtime.boss.fetch('update-openfga', { includeMetadata: true });
    expect(attempted).toEqual([]);
    expect(await current.effects()).toEqual(before);
    const jobs = await current.db.query("SELECT state FROM pgboss.job WHERE start_after = 'infinity'");
    expect(jobs.rows).toHaveLength(7);
  }
  it('keeps a partial upgrade parked even when a worker starts too early', parkedJobsCannotRun);

  async function failedScanProgress() {
    const runtime = await prepare();
    await runtime.stop();
    await current.waitForConnectionsClosed();
    function noHistory(): AsyncIterable<never> {
      throw new Error('History unavailable');
    }
    const source = { head: current.nats.store.head.bind(current.nats.store), subscribe: noHistory };
    await expect(upgradeHandlers(runtime, source)).rejects.toThrow('History unavailable');
    expect((await snapshot()).jobs).toEqual([]);
    return runtime;
  }

  async function incompatibleResume(column: string) {
    await failedScanProgress();
    if (column === 'target') {
      await current.db.query('UPDATE handler_upgrade SET target = 3');
    } else if (column === 'previous') {
      await current.db.query("UPDATE handler_upgrade SET previous = '[]'");
    } else {
      await current.db.query("UPDATE handler_upgrade SET manifest = '[]'");
    }
    const before = await snapshot();
    const progress = await current.db.query('SELECT * FROM handler_upgrade');
    await expect(command('--dry-run')).rejects.toThrow('unfinished upgrade');
    await expect(command('--confirm-writers-stopped')).rejects.toThrow('unfinished upgrade');
    expect(await snapshot()).toEqual(before);
    expect(await current.db.query('SELECT * FROM handler_upgrade')).toEqual(progress);
  }
  it.each(['manifest', 'previous', 'target'])(
    'refuses a resume with an incompatible %s and keeps saved progress', incompatibleResume);

  async function rejectsForeignHistory() {
    const runtime = await prepare();
    await runtime.stop();
    await current.waitForConnectionsClosed();
    let attempts = 0;
    const subscribe = current.nats.store.subscribe.bind(current.nats.store);
    async function* foreign(from: number, signal?: AbortSignal) {
      attempts += 1;
      for await (const row of subscribe(from, signal)) {
        yield { ...row, event: { ...row.event, silo: 'other' } };
      }
    }
    const source = { head: current.nats.store.head.bind(current.nats.store), subscribe: foreign };
    const before = await snapshot();
    await expect(upgradeHandlers(runtime, source)).rejects.toThrow('silo mismatch');
    expect(attempts).toBe(1);
    expect(await snapshot()).toEqual(before);
    const progress = await current.db.query('SELECT sequence, jobs FROM handler_upgrade');
    expect(progress.rows).toEqual([{ sequence: '0', jobs: '0' }]);
  }
  it('rejects another silo in the scan without retrying or saving jobs', rejectsForeignHistory);

  async function exhaustsHistoryRetries() {
    const runtime = await prepare();
    await runtime.stop();
    await current.waitForConnectionsClosed();
    let attempts = 0;
    function timeout(): AsyncIterable<never> {
      attempts += 1;
      const error = new Error('History timeout');
      error.name = 'TimeoutError';
      throw error;
    }
    const source = { head: current.nats.store.head.bind(current.nats.store), subscribe: timeout };
    await expect(upgradeHandlers(runtime, source)).rejects.toThrow('History timeout');
    expect(attempts).toBe(6);
    expect((await snapshot()).jobs).toEqual([]);
    const progress = await current.db.query('SELECT sequence, jobs FROM handler_upgrade');
    expect(progress.rows).toEqual([{ sequence: '0', jobs: '0' }]);
    await current.waitForConnectionsClosed();
    await upgradeHandlers(runtime, current.nats.store);
    expect((await snapshot()).jobs).toHaveLength(7);
  }
  it('stops after five history retries and can resume without lost or duplicate jobs',
    exhaustsHistoryRetries);

  async function interruptedTransaction(mode: string) {
    const runtime = await prepare();
    await runtime.stop();
    await current.waitForConnectionsClosed();
    await current.crash(mode);
    const jobs = await current.db.query<{ parked: boolean }>(
      "SELECT start_after = 'infinity' AS parked FROM pgboss.job");
    const progress = await current.db.query('SELECT sequence, jobs FROM handler_upgrade');
    const state = await current.db.query('SELECT manifest, sequence FROM handler_dispatcher');
    expect(state.rows[0]?.['sequence']).toBe('4');
    if (mode === 'upgrade-inside-chunk') {
      expect(jobs.rows).toEqual([]);
      expect(progress.rows).toEqual([{ sequence: '0', jobs: '0' }]);
      expect(state.rows[0]?.['manifest']).toBe(oldManifest);
    } else if (mode === 'upgrade-inside-publication') {
      expect(jobs.rows).toHaveLength(7);
      expect(jobs.rows).toEqual(Array.from({ length: 7 }, parkedJob));
      expect(progress.rows).toEqual([{ sequence: '4', jobs: '7' }]);
      expect(state.rows[0]?.['manifest']).toBe(oldManifest);
    } else {
      expect(jobs.rows).toHaveLength(7);
      expect(jobs.rows).toEqual(Array.from({ length: 7 }, releasedJob));
      expect(progress.rows).toEqual([]);
      expect(state.rows[0]?.['manifest']).not.toBe(oldManifest);
    }
    await current.waitForConnectionsClosed();
    await upgradeHandlers(runtime, current.nats.store);
    const completed = await snapshot();
    expect(completed.jobs).toHaveLength(7);
    expect((await current.db.query('SELECT * FROM handler_upgrade')).rows).toEqual([]);
    await current.waitForConnectionsClosed();
    await upgradeHandlers(runtime, current.nats.store);
    expect(await snapshot()).toEqual(completed);
    await runtime.start();
    await runtime.work(1);
    async function finished() {
      return (await current.effects()).length === 9;
    }
    await until(finished);
  }
  function parkedJob() {
    return { parked: true };
  }
  function releasedJob() {
    return { parked: false };
  }
  it.each(['upgrade-inside-chunk', 'upgrade-inside-publication', 'upgrade-after-publication'])(
    'recovers atomically from SIGKILL at %s and runs each unreceipted effect once',
    interruptedTransaction);

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

  async function refusesDiagnosticCancellation() {
    const runtime = await prepare();
    const id = await runtime.boss.send('update-openfga-dead', event('diagnostic-copy'));
    await current.db.query("UPDATE pgboss.job SET state = 'failed'");
    const env = { ...process.env, DATABASE_URL: current.connectionString };
    const before = await snapshot();
    await expect(execute('npm', ['run', 'ops', '--', 'jobs', '--cancel', 'invalid-id'], { env }))
      .rejects.toThrow('must be a UUID');
    await expect(execute('npm', ['run', 'ops', '--', 'jobs', '--cancel', id!], { env }))
      .rejects.toThrow('No failed job');
    const listed = await execute('npm', ['run', 'ops', '--', 'jobs'], { env });
    expect(listed.stdout).not.toContain(id);
    expect(await snapshot()).toEqual(before);
  }
  it('refuses malformed cancellation ids and leaves failed diagnostic copies untouched',
    refusesDiagnosticCancellation);

  async function historicalAndLiveTogether() {
    const runtime = await prepare();
    await current.append('live-tail', 'member-alice');
    await command('--confirm-writers-stopped');
    await runtime.start();
    void current.startDispatch(runtime);
    await current.checkpoint(5);
    await runtime.work(1);
    async function finished() {
      return (await current.effects()).length === 12;
    }
    await until(finished);
    const rows = await current.effects();
    function openfga(row: typeof rows[number]) {
      return row.handler === 'update-openfga';
    }
    function id(row: typeof rows[number]) {
      return row.event_id;
    }
    const permissions = rows.filter(openfga);
    expect(permissions.map(id)).toEqual(['joined', 'role', 'role-again', 'owner', 'live-tail']);
  }
  it('runs historical and live jobs queued together on the same key in saved order',
    historicalAndLiveTogether);

  async function orderOnlyChange() {
    const runtime = await prepare();
    function subscription(handler: typeof runtime.options.handlers[number]) {
      const eventTypes = [...handler.eventTypes];
      eventTypes.reverse();
      return { name: handler.name, eventTypes };
    }
    const manifest = runtime.options.handlers.map(subscription);
    await current.db.query('UPDATE handler_dispatcher SET manifest = $1', [JSON.stringify(manifest)]);
    const info = vi.spyOn(runtime.options.logger, 'info');
    const stop = new AbortController();
    const task = dispatch(current.nats.dispatcherConnection, runtime, stop.signal);
    try {
      function logged() {
        return Promise.resolve(info.mock.calls.length > 0);
      }
      await until(logged);
      expect(JSON.stringify(info.mock.calls)).toContain('Only subscription order changed');
      const result = await command('--dry-run');
      expect(result.stdout).toContain('"plan":[]');
      expect((await snapshot()).jobs).toEqual([]);
    } finally {
      stop.abort();
      await task;
    }
  }
  it('explains order-only changes and queues no historical jobs', orderOnlyChange);

}
describe.skipIf(!process.env["PG_TEST_URL"])("handler subscription upgrade / real services", upgradeTests);
