import { stateDir } from './state-dir.ts';
import { stopChild } from './process-stop.ts';
// Starts and stops a local Temporal DEV server (the official `temporal` CLI,
// MIT, a release binary in .tools/). `temporal server start-dev` runs every
// Temporal service in one process with an embedded SQLite file and ships the
// Web UI. It is NOT a production topology (its own help says so). The tests
// use it only to look at the Web UI and to compare its memory use with the
// production-shaped server in src/temporal-server.ts.
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';

const TEMPORAL_BIN = resolve(import.meta.dirname, '../.tools/temporal');

export interface TestTemporalDev {
  address: string; // gRPC frontend, what @temporalio/client connects to
  httpAddress: string;
  uiAddress: string | null; // the Web UI, when enabled
  namespace: string;
  child: ChildProcessByStdio<null, Readable, Readable>;
  dir: string;
  stop: () => Promise<void>;
}

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolvePort(port));
    });
  });
}

export async function startTemporalDev(label: string, opts: { ui?: boolean } = {}): Promise<TestTemporalDev> {
  const [port, httpPort, metricsPort, uiPort] = await Promise.all([freePort(), freePort(), freePort(), freePort()]);
  const dir = stateDir(`s08-temporal-dev-${label}`);
  const namespace = 'default';

  const args = [
    'server',
    'start-dev',
    '--port',
    String(port),
    '--http-port',
    String(httpPort),
    '--metrics-port',
    String(metricsPort),
    '--db-filename',
    join(dir, 'temporal.db'),
    '--namespace',
    namespace,
    '--log-level',
    'error',
  ];
  if (opts.ui) args.push('--ui-port', String(uiPort));
  else args.push('--headless');

  const child = spawn(TEMPORAL_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const lines: string[] = [];
  const record = (buf: Buffer) => {
    for (const l of buf.toString().split('\n')) if (l.trim()) lines.push(l);
  };
  child.stdout.on('data', record);
  child.stderr.on('data', record);

  const stop = async () => {
    await stopChild(child);
    rmSync(dir, { recursive: true, force: true });
  };

  // Ready when the log says so; fall back to a failure after 30 s.
  try {
    await new Promise<void>((resolveReady, reject) => {
      const timer = setTimeout(() => { clearInterval(check); reject(new Error(`temporal dev server not ready in 30s:\n${lines.slice(-15).join('\n')}`)); }, 30_000);
      const check = setInterval(() => {
        if (lines.some((l) => l.includes('Temporal Server:') || l.includes('Server:'))) {
          clearTimeout(timer);
          clearInterval(check);
          resolveReady();
        }
        if (child.exitCode !== null) {
          clearTimeout(timer);
          clearInterval(check);
          reject(new Error(`temporal dev server exited early (code ${child.exitCode}):\n${lines.slice(-15).join('\n')}`));
        }
      }, 100);
    });
  } catch (err) {
    await stop();
    throw err;
  }

  return {
    address: `127.0.0.1:${port}`,
    httpAddress: `127.0.0.1:${httpPort}`,
    uiAddress: opts.ui ? `127.0.0.1:${uiPort}` : null,
    namespace,
    child,
    dir,
    stop,
  };
}
