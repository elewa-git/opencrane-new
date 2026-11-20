import { isDeepStrictEqual } from 'node:util';
import type { Pool } from 'pg';
import type { EventStore } from '@opencrane/event-store';
import { initialiseBudgetProjection } from '@opencrane/models';
import { connectProjectionDb, ProjectionRunner, type Db } from '@opencrane/projections';
import { createLogger } from '@opencrane/observability';
import { pilotProjections, pilotProjectionNames } from './pilot-projections.ts';
import { grantPackageReads } from './package-database.ts';

const logger = createLogger('pilot-restore-projections', { level: 'silent' });
const bookkeeping = new Set(['projection_events', 'projection_generations']);

async function tableContents(db: Db) {
  const inventory = await db.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename");
  const tables: Record<string, unknown[]> = {};
  for (const { tablename } of inventory.rows) {
    if (bookkeeping.has(tablename)) continue;
    if (!/^[a-z][a-z0-9_]*$/u.test(tablename)) throw new Error('Table inventory refused');
    // Sort rows only; compare their typed fields below, including every integer-cent amount.
    const result = await db.query(`SELECT * FROM "${tablename}" t ORDER BY to_jsonb(t)`);
    tables[tablename] = result.rows;
  }
  return tables;
}

export async function replayPilotTables(db: Db, store: EventStore, sequence: number) {
  if (await store.head() !== sequence) throw new Error('Event position differs');
  await initialiseBudgetProjection(db, store, logger);
  const runner = new ProjectionRunner(db, store, logger);
  for (const projection of pilotProjections) {
    await runner.initialise(projection);
    await runner.run(projection, { toSequence: sequence });
  }
  await checkPilotCheckpoints(db, sequence);
}

export async function checkPilotCheckpoints(db: Db, sequence: number) {
  const result = await db.query<{ name: string; sequence: string }>(
    'SELECT name, sequence::text FROM projection_checkpoints ORDER BY name');
  const expected = [...pilotProjectionNames].sort();
  const names: string[] = [];
  for (const row of result.rows) {
    names.push(row.name);
    if (Number(row.sequence) !== sequence) throw new Error('Projection position differs');
  }
  if (!isDeepStrictEqual(names, expected)) throw new Error('Projection inventory differs');
}

/** Rebuild beside the dump, compare every table, then serve only replayed content. */
export async function replayPilotDatabase(admin: Pool, connectionString: string,
  store: EventStore, sequence: number, replace: boolean) {
  await admin.query('DROP DATABASE IF EXISTS pilot_replay WITH (FORCE)');
  await admin.query('CREATE DATABASE pilot_replay OWNER projection');
  await admin.query('REVOKE CONNECT ON DATABASE pilot_replay FROM PUBLIC');
  await admin.query('GRANT CONNECT ON DATABASE pilot_replay TO projection, server');
  const replayUrl = new URL(connectionString);
  replayUrl.pathname = '/pilot_replay';
  let failure: Error | undefined;
  function disconnected(cause: Error) {
    failure = new Error('Restore database connection lost', { cause });
  }
  const current = connectProjectionDb(connectionString, disconnected);
  const rebuilt = connectProjectionDb(replayUrl.href, disconnected);
  try {
    const before = await tableContents(current.db);
    await replayPilotTables(rebuilt.db, store, sequence);
    const replayed = await tableContents(rebuilt.db);
    if (failure) throw failure;
    if (!isDeepStrictEqual(before, replayed)) throw new Error('Replayed content differs');
  } finally {
    await Promise.all([current.close(), rebuilt.close()]);
  }
  if (replace) {
    await admin.query('ALTER DATABASE projections RENAME TO pilot_dump');
    await admin.query('ALTER DATABASE pilot_replay RENAME TO projections');
    await admin.query('DROP DATABASE pilot_dump');
    await grantPackageReads(connectionString);
  } else {
    await admin.query('DROP DATABASE pilot_replay');
  }
}
