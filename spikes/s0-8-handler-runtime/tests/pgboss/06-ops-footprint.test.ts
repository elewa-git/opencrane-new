// Pass condition 6: operations footprint. Processes, memory, disk, database
// connections and idle polling load of the pg-boss option, measured with the
// workers in their own Node process (the shape of the per-silo `workers`
// Deployment) and a real PostgreSQL. This is a measurement, not a pass/fail
// property; the assertions only check that the setup really did the work it
// claims to have measured.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { startPg, type TestPg } from '../../src/pg.ts';
import { startBoss, stopBoss, type TestBoss } from '../../src/pgboss-util.ts';
import { sql } from '../../src/pgboss-query.ts';
import { dirSizeBytes, processTreeRss, rssKb, spawnNodeTs, type LineProcess } from '../../src/proc.ts';
import { waitUntil } from '../../src/util.ts';

const APP_PATH = join(dirname(fileURLToPath(import.meta.url)), '../../src/pgboss-app.ts');
const MiB = (kb: number) => Math.round((kb / 1024) * 10) / 10;

describe('pg-boss: operations footprint', () => {
  let tpg: TestPg;
  let admin: TestBoss;
  let app: LineProcess | undefined;

  beforeAll(async () => {
    tpg = await startPg('ops');
    admin = await startBoss(tpg.connectionString);
  }, 90_000);

  afterAll(async () => {
    await app?.kill().catch(() => undefined);
    await stopBoss(admin);
    await tpg?.stop();
  });

  it('measures the processes, memory, disk and idle load of 10 handler queues with 2 workers each', async () => {
    app = spawnNodeTs(APP_PATH, [tpg.connectionString, '2']);
    await app.waitForLine((l) => l.includes('APP ready'), 60_000);
    const appPid = app.child.pid as number;

    // --- idle: 20 polling workers and pg-boss's own maintenance, no jobs ---
    await new Promise((r) => setTimeout(r, 3000));
    const commitsBefore = Number((await sql<{ n: string }>(tpg.connectionString, `SELECT xact_commit AS n FROM pg_stat_database WHERE datname = 'spike'`))[0]!.n);
    await new Promise((r) => setTimeout(r, 10_000));
    const commitsAfter = Number((await sql<{ n: string }>(tpg.connectionString, `SELECT xact_commit AS n FROM pg_stat_database WHERE datname = 'spike'`))[0]!.n);
    const idleCommitsPerSecond = (commitsAfter - commitsBefore) / 10;
    const idleAppRssKb = rssKb(appPid);
    const connectionsIdle = Number((await sql<{ n: string }>(tpg.connectionString, `SELECT count(*) AS n FROM pg_stat_activity WHERE datname = 'spike' AND pid <> pg_backend_pid()`))[0]!.n);

    // --- load: 5,000 events on 500 keys into one handler queue ---
    const EVENTS = 5000;
    const KEYS = 500;
    const loadStart = performance.now();
    await Promise.all(
      Array.from({ length: KEYS }, async (_, k) => {
        for (let i = 0; i < EVENTS / KEYS; i++) {
          await admin.boss.send('settle-budget', { k, i }, { singletonKey: `budget-${k}` });
        }
      }),
    );
    await waitUntil(async () => {
      const [r] = await sql<{ n: string }>(tpg.connectionString, `SELECT count(*) AS n FROM pgboss.job WHERE name = 'settle-budget' AND state = 'completed'`);
      return Number(r!.n) === EVENTS;
    }, 120_000, 250);
    const loadSeconds = (performance.now() - loadStart) / 1000;
    const loadAppRssKb = rssKb(appPid);

    // --- disk ---
    // The job table is partitioned, so add up every table of the pgboss schema (each total includes its indexes).
    const [sizes] = await sql<{ job_bytes: string; all_bytes: string }>(
      tpg.connectionString,
      `SELECT (SELECT sum(pg_total_relation_size(c.oid)) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = 'pgboss' AND c.relkind = 'r') AS job_bytes,
              pg_database_size('spike') AS all_bytes`,
    );
    const dataDirBytes = dirSizeBytes(tpg.dataDir);

    // --- the PostgreSQL process group (postmaster + its helpers + one backend per connection) ---
    const pgTree = processTreeFor(tpg.dataDir);

    const summary = {
      processes: { nodeApp: 1, postgresGroup: pgTree.processCount },
      rssMiB: { nodeAppIdle: MiB(idleAppRssKb), nodeAppAfterLoad: MiB(loadAppRssKb), postgresGroup: MiB(pgTree.rssKb) },
      dbConnectionsIdle: connectionsIdle,
      idleCommitsPerSecond: Math.round(idleCommitsPerSecond * 10) / 10,
      load: { events: EVENTS, seconds: Math.round(loadSeconds * 10) / 10, eventsPerSecond: Math.round(EVENTS / loadSeconds) },
      diskMiB: { pgbossSchema: MiB(Number(sizes!.job_bytes) / 1024), database: MiB(Number(sizes!.all_bytes) / 1024), dataDirectory: MiB(dataDirBytes / 1024) },
    };
    console.log(`[ops-footprint] ${JSON.stringify(summary)}`);

    // Sanity: the numbers describe a setup that really did the work.
    expect(pgTree.processCount).toBeGreaterThan(3);
    expect(idleAppRssKb).toBeGreaterThan(0);
    expect(connectionsIdle).toBeGreaterThan(0);
    expect(admin.errors).toEqual([]);
  }, 200_000);
});

/** Find the postmaster by its unique data directory and measure it with all its children. */
function processTreeFor(dataDir: string): { rssKb: number; processCount: number } {
  const out = execFileSync('ps', ['-axo', 'pid=,command=']).toString();
  const line = out.split('\n').find((l) => l.includes(`-D ${dataDir}`));
  if (!line) return { rssKb: 0, processCount: 0 };
  return processTreeRss(Number(line.trim().split(/\s+/)[0]));
}
