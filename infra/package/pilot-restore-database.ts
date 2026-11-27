import { isDeepStrictEqual } from 'node:util';
import type { Pool } from 'pg';
import type { EventStore } from '@opencrane/event-store';
import { initialiseBudgetProjection } from '@opencrane/models';
import {
  connectProjectionDb, conversationKeys, initialiseMemoryProjectionSchema, memoryKeys,
  memoryProjection, memoryProjectionDatabaseUrl, personalSettings, ProjectionRunner, type Db,
} from '@opencrane/projections';
import { createLogger } from '@opencrane/observability';
import { pilotProjectionsFor, pilotProjectionNames } from './pilot-projections.ts';
import { grantPackageReads } from './package-database.ts';
import { checkOnboardingEvent, MemberKeysUnavailable, type MemberKeyDirectories }
  from './pilot-member-keys.ts';

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

export async function replayPilotTables(db: Db, store: EventStore, sequence: number,
  providerMode?: boolean, personalKeys?: string) {
  if (await store.head() !== sequence) throw new Error('Event position differs');
  await initialiseBudgetProjection(db, store, logger);
  const runner = new ProjectionRunner(db, store, logger);
  const selected = pilotProjectionsFor(providerMode);
  for (const entry of selected) {
    let projection = entry;
    if (personalKeys && entry === personalSettings) {
      const keys = conversationKeys(personalKeys);
      async function prepare(event: Parameters<typeof checkOnboardingEvent>[0]) {
        checkOnboardingEvent(event, keys);
        return entry.apply;
      }
      projection = { ...entry, prepare };
    }
    await runner.initialise(projection);
    await runner.run(projection, { toSequence: sequence });
  }
  await checkPilotCheckpoints(db, sequence, providerMode);
}

export async function checkPilotCheckpoints(db: Db, sequence: number, providerMode?: boolean) {
  const result = await db.query<{ name: string; sequence: string }>(
    'SELECT name, sequence::text FROM projection_checkpoints ORDER BY name');
  const expected = pilotProjectionNames(providerMode);
  expected.sort();
  const names: string[] = [];
  for (const row of result.rows) {
    names.push(row.name);
    if (Number(row.sequence) !== sequence) throw new Error('Projection position differs');
  }
  if (!isDeepStrictEqual(names, expected)) throw new Error('Projection inventory differs');
}

export type PilotDatabaseReplay = {
  sequence: number;
  replace: boolean;
  providerMode?: boolean;
  keyDirectories?: MemberKeyDirectories;
};

async function replayMemory(connectionString: string, store: EventStore,
  sequence: number, keyDirectory: string) {
  const url = memoryProjectionDatabaseUrl(connectionString);
  if (!url) throw new Error('Memory read table schema is absent');
  const keys = memoryKeys(keyDirectory);
  function decrypt(...input: Parameters<typeof keys.decrypt>) {
    try {
      const text = keys.decrypt(...input);
      // Replay skips erased and superseded revisions before asking for a key.
      if (text === null) throw new Error('A current revision has no key');
      return text;
    } catch (cause) {
      throw new MemberKeysUnavailable(cause);
    }
  }
  let failure: Error | undefined;
  function disconnected(cause: Error) {
    failure = new Error('Restore Memory database connection lost', { cause });
  }
  const db = connectProjectionDb(url, disconnected);
  try {
    await initialiseMemoryProjectionSchema(db.db);
    const projection = memoryProjection({ decrypt });
    const runner = new ProjectionRunner(db.db, store, logger);
    await runner.initialise(projection);
    await runner.run(projection, { toSequence: sequence });
    if (failure) throw failure;
    if (await runner.checkpoint(projection) !== sequence) {
      throw new Error('Memory projection position differs');
    }
  } finally {
    await db.close();
  }
}

/** Rebuild beside the dump, compare every table, then serve only replayed content. */
export async function replayPilotDatabase(admin: Pool, connectionString: string,
  store: EventStore, replay: PilotDatabaseReplay) {
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
    await replayPilotTables(rebuilt.db, store, replay.sequence, replay.providerMode,
      replay.keyDirectories?.personal);
    const replayed = await tableContents(rebuilt.db);
    if (failure) throw failure;
    if (!isDeepStrictEqual(before, replayed)) throw new Error('Replayed content differs');
  } finally {
    await Promise.all([current.close(), rebuilt.close()]);
  }
  if (replay.keyDirectories) {
    await replayMemory(replayUrl.href, store, replay.sequence, replay.keyDirectories.memory);
  }
  if (replay.replace) {
    await admin.query('ALTER DATABASE projections RENAME TO pilot_dump');
    await admin.query('ALTER DATABASE pilot_replay RENAME TO projections');
    await admin.query('DROP DATABASE pilot_dump');
    await grantPackageReads(connectionString);
  } else {
    await admin.query('DROP DATABASE pilot_replay');
  }
}
