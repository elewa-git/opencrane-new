import type { Logger } from '@opencrane/observability';
import { ProjectionRunner, type Db, type Query, type EventSource } from '@opencrane/projections';
import { budgets, replayBudgets, budgetProjectionVersion } from './accounting.ts';
async function versions(db: Query) {
  await db.query('CREATE TABLE IF NOT EXISTS projection_versions (name TEXT PRIMARY KEY, version INTEGER NOT NULL)');
}
async function removeReplay(db: Query) {
  await replayBudgets.drop(db);
  await db.query('DELETE FROM projection_events WHERE projection = $1', [replayBudgets.name]);
  await db.query('DELETE FROM projection_checkpoints WHERE name = $1', [replayBudgets.name]);
  await db.query('DELETE FROM projection_generations WHERE name = $1', [replayBudgets.name]);
}
async function rows(db: Query, table: string) {
  return (await db.query(`SELECT * FROM ${table} ORDER BY silo`)).rows;
}
async function indexedRows(db: Query, table: string, key: string, after: [string, string]) {
  const result = await db.query<{ silo: string; row_id: string }>(
    `SELECT *, ${key} AS row_id FROM ${table} WHERE (silo, ${key}) > ($1, $2)
      ORDER BY silo, ${key} LIMIT 200`, after);
  return result.rows;
}
async function sameRows(db: Query, table: string, key: 'reservation_id' | 'event_id') {
  let after: [string, string] = ['', ''];
  while (true) {
    const live = await indexedRows(db, table, key, after);
    const replayed = await indexedRows(db, `${table}_replay`, key, after);
    if (JSON.stringify(live) !== JSON.stringify(replayed)) return false;
    if (live.length < 200) return true;
    const last = live.at(-1)!;
    after = [last.silo, last.row_id];
  }
}
async function rebuildLocked(db: Db, source: EventSource, logger: Logger, verify: boolean) {
  const runner = new ProjectionRunner(db, source, logger);
  await runner.initialise(budgets);
  await versions(db);
  const previousSequence = await runner.checkpoint(budgets);
  await db.transaction(removeReplay);
  await runner.initialise(replayBudgets);
  try {
    await runner.run(replayBudgets, { toSequence: previousSequence });
    const budgetsUnchanged = JSON.stringify(await rows(db, 'model_budgets')) === JSON.stringify(await rows(db, 'model_budgets_replay'));
    const callsUnchanged = await sameRows(db, 'model_budget_calls', 'reservation_id');
    const effectsUnchanged = await sameRows(db, 'model_budget_effects', 'event_id');
    const unchanged = budgetsUnchanged && callsUnchanged && effectsUnchanged;
    if (verify && !unchanged) throw new Error('Rebuilt budgets state differs from the live projection');
    const sequence = await source.head();
    await runner.run(replayBudgets, { toSequence: sequence });
    await db.transaction(async tx => {
      await tx.query("SET LOCAL lock_timeout = '250ms'");
      await tx.query(`LOCK TABLE model_budgets, model_budgets_replay,
        model_budget_calls, model_budget_calls_replay,
        model_budget_effects, model_budget_effects_replay IN ACCESS EXCLUSIVE MODE`);
      // Retain the live table object and its reader grants.
      await tx.query('TRUNCATE model_budgets');
      await tx.query('INSERT INTO model_budgets SELECT * FROM model_budgets_replay');
      await tx.query('TRUNCATE model_budget_calls');
      await tx.query('INSERT INTO model_budget_calls SELECT * FROM model_budget_calls_replay');
      await tx.query('TRUNCATE model_budget_effects');
      await tx.query('INSERT INTO model_budget_effects SELECT * FROM model_budget_effects_replay');
      await replayBudgets.drop(tx);
      await tx.query('DELETE FROM projection_events WHERE projection = $1', [budgets.name]);
      await tx.query('UPDATE projection_events SET projection = $1 WHERE projection = $2', [budgets.name, replayBudgets.name]);
      await tx.query('DELETE FROM projection_checkpoints WHERE name = $1', [budgets.name]);
      await tx.query('UPDATE projection_checkpoints SET name = $1 WHERE name = $2', [budgets.name, replayBudgets.name]);
      await tx.query('DELETE FROM projection_generations WHERE name = $1', [replayBudgets.name]);
      if (!unchanged) await tx.query('UPDATE projection_generations SET generation = generation + 1 WHERE name = $1', [budgets.name]);
      await tx.query('INSERT INTO projection_versions VALUES ($1, $2) ON CONFLICT (name) DO UPDATE SET version = $2', [budgets.name, budgetProjectionVersion]);
    });
    return { previousSequence, sequence, verified: verify, changed: !unchanged };
  } catch (error) {
    await db.transaction(removeReplay).catch((cleanupError: unknown) => {
      throw new AggregateError([error, cleanupError], 'Budget rebuild and cleanup failed');
    });
    throw error;
  }
}
/** Replay into a shadow table and atomically replace the live projection, without reactions. */
export async function rebuildBudgetProjection(db: Db, source: EventSource, logger: Logger, { verify = false }: { verify?: boolean } = {}) {
  if (!db.lock) throw new Error('Budget rebuild requires projection locking');
  return db.lock(budgets.name, locked => rebuildLocked(locked, source, logger, verify));
}
/** Upgrade legacy rows before the worker resumes from its existing checkpoint. */
export async function initialiseBudgetProjection(db: Db, source: EventSource, logger: Logger) {
  if (!db.lock) throw new Error('Budget upgrade requires projection locking');
  await db.lock(budgets.name, async locked => {
    await new ProjectionRunner(locked, source, logger).initialise(budgets);
    await versions(locked);
    const result = await locked.query<{ version: number }>('SELECT version FROM projection_versions WHERE name = $1', [budgets.name]);
    if ((result.rows[0]?.version ?? 1) < budgetProjectionVersion) await rebuildLocked(locked, source, logger, false);
  });
}
