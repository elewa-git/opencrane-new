// Pass condition 6: operations footprint. Processes, memory, disk, database
// connections and idle load of the Temporal option on a real PostgreSQL, in
// the production-shaped topology (Temporal's own services, SQL persistence),
// with the workers in their own Node process. Measured twice: all four
// Temporal services in one process (the binary's default), and as four
// separate processes (the way a Kubernetes install runs them). The dev
// server is measured once for comparison. This is a measurement, not a
// pass/fail property; the assertions only check that the setup really did the
// work it claims to have measured.
import { afterEach, describe, expect, it } from 'vitest';
import { Connection, Client as WorkflowClient } from '@temporalio/client';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { startTemporalServer, type ServerMode, type TestTemporalServer } from '../../src/temporal-server.ts';
import { startTemporalDev } from '../../src/temporal.ts';
import { sql } from '../../src/pgboss-query.ts';
import { dirSizeBytes, processTreeRss, rssKb, spawnNodeTs, type LineProcess } from '../../src/proc.ts';
import { keyName } from '../../src/scenario.ts';

const WORKER_PATH = join(dirname(fileURLToPath(import.meta.url)), '../../src/temporal-worker-process.ts');
const MiB = (kb: number) => Math.round((kb / 1024) * 10) / 10;

function postmasterTree(dataDir: string): { rssKb: number; processCount: number } {
  const out = execFileSync('ps', ['-axo', 'pid=,command=']).toString();
  const line = out.split('\n').find((l) => l.includes(`-D ${dataDir}`));
  return line ? processTreeRss(Number(line.trim().split(/\s+/)[0])) : { rssKb: 0, processCount: 0 };
}

describe('temporal: operations footprint', () => {
  const cleanup: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) await fn();
  });

  async function measureServer(mode: ServerMode) {
    const server: TestTemporalServer = await startTemporalServer(`ops-${mode}`, { mode });
    cleanup.push(() => server.stop());
    const worker: LineProcess = spawnNodeTs(WORKER_PATH, [server.address, server.namespace, 'ops-tq']);
    cleanup.push(async () => void (await worker.kill()));
    await worker.waitForLine((l) => l.includes('WORKER ready'), 60_000);
    const connection = await Connection.connect({ address: server.address });
    cleanup.push(() => connection.close());
    const client = new WorkflowClient({ connection, namespace: server.namespace });

    // --- idle: one worker long-polling, no workflows ---
    const commits = async () =>
      Number((await sql<{ n: string }>(server.tpg.connectionString, `SELECT sum(xact_commit) AS n FROM pg_stat_database WHERE datname IN ('temporal','temporal_visibility')`))[0]!.n);
    await new Promise((r) => setTimeout(r, 3000));
    const c0 = await commits();
    await new Promise((r) => setTimeout(r, 10_000));
    const idleCommitsPerSecond = ((await commits()) - c0) / 10;
    const serverIdleKb = server.children.reduce((sum, c) => sum + rssKb(c.child.pid as number), 0);
    const connectionsIdle = Number(
      (await sql<{ n: string }>(server.tpg.connectionString, `SELECT count(*) AS n FROM pg_stat_activity WHERE datname IN ('temporal','temporal_visibility')`))[0]!.n,
    );

    // --- load: 5,000 events over 500 keys (10 per key), each key's workflow ends after its 10th ---
    const EVENTS = 5000;
    const KEYS = 500;
    const PER_KEY = EVENTS / KEYS;
    const t0 = performance.now();
    await Promise.all(
      Array.from({ length: KEYS }, async (_, k) => {
        for (let seq = 0; seq < PER_KEY; seq++) {
          await client.workflow.signalWithStart('keyedEventProcessor', {
            taskQueue: 'ops-tq',
            workflowId: `ops-${keyName(k)}`,
            args: [{ key: keyName(k), completeAfter: PER_KEY }],
            signal: 'pushEvent',
            signalArgs: [{ eventId: `${keyName(k)}#${seq}`, seq }],
          });
        }
      }),
    );
    await Promise.all(Array.from({ length: KEYS }, (_, k) => client.workflow.getHandle(`ops-${keyName(k)}`).result()));
    const loadSeconds = (performance.now() - t0) / 1000;

    const perProcess = Object.fromEntries(server.children.map((c) => [c.service, MiB(rssKb(c.child.pid as number))]));
    const serverLoadKb = server.children.reduce((sum, c) => sum + rssKb(c.child.pid as number), 0);
    const [dbSizes] = await sql<{ main: string; vis: string }>(
      server.tpg.connectionString,
      `SELECT pg_database_size('temporal') AS main, pg_database_size('temporal_visibility') AS vis`,
    );
    const history = await client.workflow.getHandle(`ops-${keyName(0)}`).describe();
    const pgTree = postmasterTree(server.tpg.dataDir);
    const summary = {
      mode,
      processes: { temporalServer: server.children.length, worker: 1, postgresGroup: pgTree.processCount },
      rssMiB: {
        temporalServerIdle: MiB(serverIdleKb),
        temporalServerAfterLoad: MiB(serverLoadKb),
        perServiceAfterLoad: perProcess,
        worker: MiB(rssKb(worker.child.pid as number)),
        postgresGroup: MiB(pgTree.rssKb),
      },
      dbConnectionsIdle: connectionsIdle,
      idleCommitsPerSecond: Math.round(idleCommitsPerSecond * 10) / 10,
      load: { events: EVENTS, workflows: KEYS, seconds: Math.round(loadSeconds * 10) / 10, eventsPerSecond: Math.round(EVENTS / loadSeconds) },
      historyEventsPerKeyWorkflow: history.historyLength,
      diskMiB: { temporalDb: MiB(Number(dbSizes!.main) / 1024), visibilityDb: MiB(Number(dbSizes!.vis) / 1024), dataDirectory: MiB(dirSizeBytes(server.tpg.dataDir) / 1024) },
    };
    console.log(`[ops-footprint] ${JSON.stringify(summary)}`);
    expect(pgTree.processCount).toBeGreaterThan(3);
    expect(server.children.length).toBe(mode === 'all' ? 1 : 4);
    expect(history.historyLength, 'each key workflow recorded its events in history').toBeGreaterThan(PER_KEY);
    return summary;
  }

  it('production-shaped, all Temporal services in one process', async () => {
    await measureServer('all');
  }, 240_000);

  it('production-shaped, the four Temporal services as four processes', async () => {
    await measureServer('split');
  }, 240_000);

  it('the dev server (SQLite, one process), for comparison', async () => {
    const dev = await startTemporalDev('ops-dev', { ui: true });
    cleanup.push(() => dev.stop());
    await new Promise((r) => setTimeout(r, 3000));
    const rss = MiB(rssKb(dev.child.pid as number));
    console.log(`[ops-footprint] dev server (not a production topology): 1 process, ${rss} MiB RSS idle, SQLite file, Web UI included`);
    expect(rss).toBeGreaterThan(0);
  }, 90_000);
});
