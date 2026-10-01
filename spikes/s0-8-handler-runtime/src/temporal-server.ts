import { stateDir } from './state-dir.ts';
import { stopChild } from './process-stop.ts';
// Starts a production-shaped Temporal Server (the official `temporal-server`
// release binary, MIT) on a real local PostgreSQL, with no Docker. This is
// the topology a silo would actually run: Temporal's own services plus an
// SQL database, as opposed to `temporal server start-dev` (src/temporal.ts),
// which keeps everything in one process with an embedded SQLite file.
//
// `split` mode starts the four Temporal services (frontend, history,
// matching, worker) as four separate OS processes, the way a Kubernetes
// install runs them as separate Deployments. `all` mode starts one process
// that runs all four, which is the binary's default.
import { spawn, execFileSync, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { Client } from 'pg';
import { Connection } from '@temporalio/client';
import { msToTs } from '@temporalio/common';
import { startPg, type TestPg } from './pg.ts';

const TOOLS_DIR = resolve(import.meta.dirname, '../.tools/temporal-server');
const SERVER_BIN = join(TOOLS_DIR, 'temporal-server');
const SQL_TOOL = join(TOOLS_DIR, 'temporal-sql-tool');

export type ServerMode = 'all' | 'split';
const SERVICES = ['frontend', 'history', 'matching', 'worker'] as const;

export interface TestTemporalServer {
  address: string; // host:port of the frontend gRPC port
  httpAddress: string; // host:port of the frontend HTTP API
  namespace: string;
  mode: ServerMode;
  tpg: TestPg;
  children: { service: string; child: ChildProcessByStdio<null, Readable, Readable> }[];
  logLines: string[];
  stop: () => Promise<void>;
}

/**
 * Pick `count` free TCP ports. Temporal stores each service's membership
 * port in a PostgreSQL smallint column, so every port must be below 32768;
 * the usual "ask the OS for any free port" trick would hand out ports above
 * that, so we probe a range below it ourselves.
 */
async function pickFreePorts(count: number): Promise<number[]> {
  const chosen: number[] = [];
  while (chosen.length < count) {
    const port = 16000 + Math.floor(Math.random() * 16000);
    if (chosen.includes(port)) continue;
    const free = await new Promise<boolean>((resolveFree) => {
      const srv = createServer();
      srv.once('error', () => resolveFree(false));
      srv.listen(port, '127.0.0.1', () => srv.close(() => resolveFree(true)));
    });
    if (free) chosen.push(port);
  }
  return chosen;
}

function buildConfig(pgPort: number, ports: number[], shards: number): string {
  const p = (offset: number) => ports[offset] as number;
  const sql = (db: string, maxConns: number) => `
      sql:
        pluginName: "postgres12"
        databaseName: "${db}"
        connectAddr: "127.0.0.1:${pgPort}"
        connectProtocol: "tcp"
        user: "postgres"
        password: "postgres"
        maxConns: ${maxConns}
        maxIdleConns: ${maxConns}
        maxConnLifetime: "1h"`;
  return `
log:
  stdout: true
  level: warn
persistence:
  defaultStore: pg-default
  visibilityStore: pg-visibility
  numHistoryShards: ${shards}
  datastores:
    pg-default:${sql('temporal', 20)}
    pg-visibility:${sql('temporal_visibility', 4)}
global:
  membership:
    maxJoinDuration: 30s
    broadcastAddress: "127.0.0.1"
services:
  frontend:
    rpc: { grpcPort: ${p(0)}, membershipPort: ${p(1)}, bindOnLocalHost: true, httpPort: ${p(2)} }
  matching:
    rpc: { grpcPort: ${p(3)}, membershipPort: ${p(4)}, bindOnLocalHost: true }
  history:
    rpc: { grpcPort: ${p(5)}, membershipPort: ${p(6)}, bindOnLocalHost: true }
  worker:
    rpc: { grpcPort: ${p(7)}, membershipPort: ${p(8)}, bindOnLocalHost: true }
clusterMetadata:
  enableGlobalNamespace: false
  failoverVersionIncrement: 10
  masterClusterName: "active"
  currentClusterName: "active"
  clusterInformation:
    active:
      enabled: true
      initialFailoverVersion: 1
      rpcName: "frontend"
      rpcAddress: "localhost:${p(0)}"
dcRedirectionPolicy:
  policy: "noop"
`;
}

/** Create the two Temporal databases and load their schema using the official sql-tool. */
async function prepareDatabases(tpg: TestPg): Promise<void> {
  const admin = new Client({ connectionString: tpg.connectionString });
  await admin.connect();
  await admin.query('CREATE DATABASE temporal');
  await admin.query('CREATE DATABASE temporal_visibility');
  await admin.end();
  const env = {
    ...process.env,
    SQL_HOST: '127.0.0.1',
    SQL_PORT: String(tpg.port),
    SQL_USER: 'postgres',
    SQL_PASSWORD: 'postgres',
    SQL_PLUGIN: 'postgres12',
  };
  // The embedded schema files are the full, current schema; -v records the
  // schema version the 1.32.0 server expects (read from the release's
  // schema/postgresql/v12/*/versioned directories: main store 1.19,
  // visibility store 1.14).
  for (const [db, schema, version] of [
    ['temporal', 'postgresql/v12/temporal', '1.19'],
    ['temporal_visibility', 'postgresql/v12/visibility', '1.14'],
  ] as const) {
    execFileSync(SQL_TOOL, ['--database', db, 'setup-schema', '-s', schema, '-v', version], { env, stdio: 'pipe' });
  }
}

export async function startTemporalServer(
  label: string,
  opts: { mode?: ServerMode; numHistoryShards?: number } = {},
): Promise<TestTemporalServer> {
  const mode = opts.mode ?? 'all';
  const tpg = await startPg(`temporal-${label}`);
  try { await prepareDatabases(tpg); } catch (error) { await tpg.stop(); throw error; }

  const ports = await pickFreePorts(9);
  const dir = stateDir(`s08-temporal-prod-${label}`);
  const configFile = join(dir, 'config.yaml');
  writeFileSync(configFile, buildConfig(tpg.port, ports, opts.numHistoryShards ?? 4));

  const logLines: string[] = [];
  const children: TestTemporalServer['children'] = [];
  const launch = (service: string | null) => {
    // Global flags go before the `start` command.
    const args = ['--config-file', configFile, '--allow-no-auth', 'start'];
    if (service) args.push('--service', service);
    const child = spawn(SERVER_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'], cwd: TOOLS_DIR });
    const record = (buf: Buffer) => {
      for (const line of buf.toString().split('\n')) if (line.trim()) logLines.push(`[${service ?? 'all'}] ${line}`);
      if (logLines.length > 400) logLines.splice(0, logLines.length - 400);
    };
    child.stdout.on('data', record);
    child.stderr.on('data', record);
    children.push({ service: service ?? 'all', child });
  };
  if (mode === 'all') launch(null);
  else {
    // Start the services one after another. When all four start in the same
    // instant they race to write the cluster metadata row and one of them
    // exits (a real install avoids this because the orchestrator restarts a
    // failed service; here we simply avoid the race).
    for (const s of SERVICES) {
      launch(s);
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  const address = `127.0.0.1:${ports[0]}`;
  const stop = async () => {
    await Promise.all(children.map(({ child }) => stopChild(child)));
    await tpg.stop();
    rmSync(dir, { recursive: true, force: true });
  };

  // Wait until the frontend answers, then register the namespace the tests use.
  const namespace = 'default';
  try {
    const deadline = Date.now() + 90_000;
    let connection: Connection | undefined;
    for (;;) {
      for (const { service, child } of children) {
        if (child.exitCode !== null) {
          throw new Error(`temporal ${service} exited early (code ${child.exitCode}). Last log lines:\n${logLines.slice(-25).join('\n')}`);
        }
      }
      try {
        connection = await Connection.connect({ address, connectTimeout: 2000 });
        await connection.workflowService.getSystemInfo({});
        break;
      } catch {
        await connection?.close().catch(() => undefined);
        connection = undefined;
        if (Date.now() > deadline) throw new Error(`temporal frontend not ready in 90s. Last log lines:\n${logLines.slice(-25).join('\n')}`);
        await new Promise((r) => setTimeout(r, 300));
      }
    }
    await connection.workflowService.registerNamespace({
      namespace,
      workflowExecutionRetentionPeriod: msToTs('24h'),
    });
    // A namespace becomes usable shortly after registration (cache refresh).
    for (let i = 0; i < 100; i++) {
      try {
        await connection.workflowService.describeNamespace({ namespace });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    await connection.close();
  } catch (err) {
    await stop();
    throw err;
  }

  return { address, httpAddress: `127.0.0.1:${ports[2]}`, namespace, mode, tpg, children, logLines, stop };
}
