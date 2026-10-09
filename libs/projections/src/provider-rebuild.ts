import type { Logger } from '@opencrane/observability';
import type { Db, Query } from './db.ts';
import { providers, replayProviders } from './providers.ts';
import { ProjectionRunner, type EventSource } from './runner.ts';

async function removeReplay(tx: Query) {
  await replayProviders.drop(tx);
  await tx.query('DELETE FROM projection_events WHERE projection = $1', [replayProviders.name]);
  for (const table of ['projection_checkpoints', 'projection_generations']) {
    await tx.query(`DELETE FROM ${table} WHERE name = $1`, [replayProviders.name]);
  }
}
async function state(db: Query, table: 'providers' | 'providers_replay') {
  const result = await db.query(`SELECT * FROM ${table} ORDER BY silo, provider_id`);
  const bindings = table === 'providers' ? 'model_bindings' : 'model_bindings_replay';
  const choices = await db.query(`SELECT * FROM ${bindings} ORDER BY silo, kind, dependant_id, task`);
  return { providers: result.rows, bindings: choices.rows };
}
async function switchTables(tx: Query, head: number, unchanged: boolean) {
  await tx.query("SET LOCAL lock_timeout = '250ms'");
  await tx.query(`LOCK TABLE providers, providers_replay, model_bindings, model_bindings_replay
    IN ACCESS EXCLUSIVE MODE`);
  await tx.query('TRUNCATE model_bindings');
  await tx.query('INSERT INTO model_bindings SELECT * FROM model_bindings_replay');
  await tx.query('TRUNCATE providers');
  await tx.query('INSERT INTO providers SELECT * FROM providers_replay');
  await replayProviders.drop(tx);
  await tx.query('DELETE FROM projection_events WHERE projection = $1', [providers.name]);
  await tx.query('UPDATE projection_events SET projection = $1 WHERE projection = $2',
    [providers.name, replayProviders.name]);
  await tx.query('UPDATE projection_checkpoints SET sequence = $2 WHERE name = $1',
    [providers.name, head]);
  if (!unchanged) {
    await tx.query('UPDATE projection_generations SET generation = generation + 1 WHERE name = $1',
      [providers.name]);
  }
  for (const table of ['projection_checkpoints', 'projection_generations']) {
    await tx.query(`DELETE FROM ${table} WHERE name = $1`, [replayProviders.name]);
  }
}

/** Rebuild beside the live tables; the switch and checkpoint update must commit together. */
export async function rebuildProviderProjection(
  db: Db, source: EventSource, logger: Logger, { verify = false }: { verify?: boolean } = {},
) {
  if (!db.lock) {
    throw new Error('Provider rebuild requires projection locking');
  }
  async function rebuild(locked: Db) {
    const runner = new ProjectionRunner(locked, source, logger);
    await runner.initialise(providers);
    const checkpoint = await runner.checkpoint(providers);
    await locked.transaction(removeReplay);
    await runner.initialise(replayProviders);
    try {
      await runner.run(replayProviders, { toSequence: checkpoint });
      const liveState = await state(locked, 'providers');
      const replayState = await state(locked, 'providers_replay');
      const unchanged = JSON.stringify(liveState) === JSON.stringify(replayState);
      if (verify && !unchanged) {
        throw new Error('Rebuilt providers differ from the live projection');
      }
      const head = await source.head();
      await runner.run(replayProviders, { toSequence: head });
      function switchProjection(tx: Query) {
        return switchTables(tx, head, unchanged);
      }
      await locked.transaction(switchProjection);
      return { previousSequence: checkpoint, sequence: head,
        verified: verify, changed: !unchanged };
    } catch (error) {
      try {
        await locked.transaction(removeReplay);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Provider rebuild and cleanup failed',
          { cause: cleanupError });
      }
      throw error;
    }
  }
  return db.lock(providers.name, rebuild);
}
