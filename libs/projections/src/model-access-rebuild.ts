import type { Logger } from '@opencrane/observability';
import type { Db, Query } from './db.ts';
import { modelAccess, replayModelAccess } from './model-access.ts';
import { ProjectionRunner, type EventSource } from './runner.ts';

async function removeReplay(db: Query) {
  await replayModelAccess.drop(db);
  await db.query('DELETE FROM projection_events WHERE projection = $1', [replayModelAccess.name]);
  for (const table of ['projection_checkpoints', 'projection_generations']) {
    await db.query(`DELETE FROM ${table} WHERE name = $1`, [replayModelAccess.name]);
  }
}

async function projectionRows(db: Query, suffix: string) {
  const grants = await db.query(`SELECT * FROM model_access_grants${suffix} ORDER BY silo, model_id,
    grantee_kind, grantee_id`);
  const assistants = await db.query(`SELECT * FROM model_access_assistants${suffix}
    ORDER BY silo, assistant_id`);
  return { grants: grants.rows, assistants: assistants.rows };
}

async function switchTables(db: Query, head: number, changed: boolean) {
  await db.query("SET LOCAL lock_timeout = '250ms'");
  await db.query(`LOCK TABLE model_access_grants, model_access_assistants,
    model_access_grants_replay, model_access_assistants_replay IN ACCESS EXCLUSIVE MODE`);
  await db.query('TRUNCATE model_access_grants, model_access_assistants');
  await db.query('INSERT INTO model_access_grants SELECT * FROM model_access_grants_replay');
  await db.query('INSERT INTO model_access_assistants SELECT * FROM model_access_assistants_replay');
  await replayModelAccess.drop(db);
  await db.query('DELETE FROM projection_events WHERE projection = $1', [modelAccess.name]);
  await db.query('UPDATE projection_events SET projection = $1 WHERE projection = $2',
    [modelAccess.name, replayModelAccess.name]);
  await db.query('UPDATE projection_checkpoints SET sequence = $2 WHERE name = $1',
    [modelAccess.name, head]);
  if (changed) {
    await db.query('UPDATE projection_generations SET generation = generation + 1 WHERE name = $1',
      [modelAccess.name]);
  }
  for (const table of ['projection_checkpoints', 'projection_generations']) {
    await db.query(`DELETE FROM ${table} WHERE name = $1`, [replayModelAccess.name]);
  }
}

/** Rebuild model grants and assistant names beside the live tables. */
export async function rebuildModelAccessProjection(db: Db, source: EventSource,
  logger: Logger, { verify = false }: { verify?: boolean } = {}) {
  if (!db.lock) throw new Error('Model access rebuild requires projection locking');

  async function rebuild(locked: Db) {
    const runner = new ProjectionRunner(locked, source, logger);
    await runner.initialise(modelAccess);
    const checkpoint = await runner.checkpoint(modelAccess);
    await locked.transaction(removeReplay);
    await runner.initialise(replayModelAccess);
    try {
      await runner.run(replayModelAccess, { toSequence: checkpoint });
      const current = await projectionRows(locked, '');
      const replayed = await projectionRows(locked, '_replay');
      const unchanged = JSON.stringify(current) === JSON.stringify(replayed);
      if (verify && !unchanged) {
        throw new Error('Rebuilt model access differs from the live projection');
      }
      const head = await source.head();
      await runner.run(replayModelAccess, { toSequence: head });
      async function switchReplay(tx: Query) {
        await switchTables(tx, head, !unchanged);
      }
      await locked.transaction(switchReplay);
      return { previousSequence: checkpoint, sequence: head, verified: verify, changed: !unchanged };
    } catch (error) {
      try {
        await locked.transaction(removeReplay);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError],
          'Model access rebuild and cleanup failed', { cause: cleanupError });
      }
      throw error;
    }
  }

  return db.lock(modelAccess.name, rebuild);
}
