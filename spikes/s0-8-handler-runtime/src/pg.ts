import { stateDir } from './state-dir.ts';
// Start and stop a real, local PostgreSQL for a test file, using the
// embedded-postgres package (MIT wrapper that ships the official PostgreSQL
// binaries under the PostgreSQL licence). No Docker and no system Postgres.
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { rmSync } from 'node:fs';

export interface TestPg {
  pg: EmbeddedPostgres;
  connectionString: string;
  dataDir: string;
  port: number;
  /** Server log lines (kept in memory, newest last) for debugging a failed run. */
  log: string[];
  stop: () => Promise<void>;
}

// A random port in a wide, uncommon range. This machine sometimes runs other
// sessions and spikes at the same time, and a fixed port collided with them
// during development (the symptom was "terminating connection due to
// administrator command", which had nothing to do with the code under test).
function randomPort(): number {
  return 20000 + Math.floor(Math.random() * 12000);
}

export async function startPg(label: string): Promise<TestPg> {
  const port = randomPort();
  const dataDir = stateDir(`s08-pg-${label}`);
  const log: string[] = [];
  const keep = (message: unknown) => {
    log.push(String(message).trimEnd());
    if (log.length > 200) log.splice(0, log.length - 200);
  };
  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: 'postgres',
    password: 'postgres',
    port,
    persistent: false,
    onLog: keep,
    onError: keep,
    // This sandbox has a tiny System V shared-memory ceiling
    // (kern.sysv.shmall), too small for PostgreSQL's default main
    // shared-memory segment. Use the "mmap" backend (anonymous mmap, no SysV
    // segment) instead of changing an operating-system setting.
    initdbFlags: ['-c', 'shared_memory_type=mmap', '-c', 'dynamic_shared_memory_type=posix'],
    postgresFlags: ['-c', 'shared_memory_type=mmap', '-c', 'dynamic_shared_memory_type=posix'],
  });
  try {
    await pg.initialise();
    await pg.start();
    await pg.createDatabase('spike');
  } catch (error) {
    await pg.stop();
    rmSync(dataDir, { recursive: true, force: true });
    throw error;
  }
  const connectionString = `postgresql://postgres:postgres@localhost:${port}/spike`;
  return {
    pg,
    connectionString,
    dataDir,
    port,
    log,
    stop: async () => {
      await pg.stop();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/**
 * A pooled client with an error listener attached. Idle connections can
 * receive "terminating connection" when the test database is stopped; without
 * a listener Node reports that as an unhandled error and fails the run.
 */
export function newPool(connectionString: string, max: number): pg.Pool {
  const pool = new pg.Pool({ connectionString, max });
  pool.on('error', () => undefined);
  return pool;
}
