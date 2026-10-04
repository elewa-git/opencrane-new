import type { Logger } from '@opencrane/observability';
import type { Db, Query } from './db.ts';
import { groups, replayGroups } from './groups.ts';
import { ProjectionRunner, type EventSource } from './runner.ts';

const tables = ['groups', 'group_members', 'group_access'];
async function removeReplay(tx: Query) {
  await replayGroups.drop(tx);
  await tx.query('DELETE FROM projection_events WHERE projection = $1', [replayGroups.name]);
  for (const table of ['projection_checkpoints', 'projection_generations']) {
    await tx.query(`DELETE FROM ${table} WHERE name = $1`, [replayGroups.name]);
  }
}
function orderColumns(table: string) {
  if (table === 'group_members') return 'silo, group_id, member_id';
  if (table === 'group_access') return 'silo, group_id, resource_type, resource_id, relation';
  return 'silo, group_id';
}
async function state(db: Query, suffix: string) {
  async function readTable(table: string) {
    const columns = orderColumns(table);
    const result = await db.query(`SELECT * FROM ${table}${suffix} ORDER BY ${columns}`);
    return result.rows;
  }
  const pendingTables = tables.map(readTable);
  return Promise.all(pendingTables);
}
function tablePair(table: string) {
  return [table, `${table}_replay`];
}
async function switchTables(tx: Query, head: number, unchanged: boolean) {
  await tx.query("SET LOCAL lock_timeout = '250ms'");
  const lockTables = tables.flatMap(tablePair);
  const lockList = lockTables.join(', ');
  await tx.query(`LOCK TABLE ${lockList} IN ACCESS EXCLUSIVE MODE`);
  const liveList = tables.join(', ');
  await tx.query(`TRUNCATE ${liveList}`);
  for (const table of tables) {
    await tx.query(`INSERT INTO ${table} SELECT * FROM ${table}_replay`);
  }
  await replayGroups.drop(tx);
  await tx.query('DELETE FROM projection_events WHERE projection = $1', [groups.name]);
  await tx.query('UPDATE projection_events SET projection = $1 WHERE projection = $2',
    [groups.name, replayGroups.name]);
  await tx.query('UPDATE projection_checkpoints SET sequence = $2 WHERE name = $1',
    [groups.name, head]);
  if (!unchanged) {
    await tx.query('UPDATE projection_generations SET generation = generation + 1 WHERE name = $1',
      [groups.name]);
  }
  for (const table of ['projection_checkpoints', 'projection_generations']) {
    await tx.query(`DELETE FROM ${table} WHERE name = $1`, [replayGroups.name]);
  }
}

/** Rebuild beside the live tables; the switch and checkpoint update must commit together. */
export async function rebuildGroupProjection(
  db: Db, source: EventSource, logger: Logger, { verify = false }: { verify?: boolean } = {},
) {
  if (!db.lock) throw new Error('Group rebuild requires projection locking');
  async function rebuild(locked: Db) {
    const runner = new ProjectionRunner(locked, source, logger);
    await runner.initialise(groups);
    const checkpoint = await runner.checkpoint(groups);
    await locked.transaction(removeReplay);
    await runner.initialise(replayGroups);
    try {
      await runner.run(replayGroups, { toSequence: checkpoint });
      const liveState = await state(locked, '');
      const replayState = await state(locked, '_replay');
      const unchanged = JSON.stringify(liveState) === JSON.stringify(replayState);
      if (verify && !unchanged) throw new Error('Rebuilt groups differ from the live projection');
      const head = await source.head();
      await runner.run(replayGroups, { toSequence: head });
      function switchProjection(tx: Query) {
        return switchTables(tx, head, unchanged);
      }
      await locked.transaction(switchProjection);
      return { previousSequence: checkpoint, sequence: head, verified: verify, changed: !unchanged };
    } catch (error) {
      try {
        await locked.transaction(removeReplay);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Group rebuild and cleanup failed',
          { cause: cleanupError });
      }
      throw error;
    }
  }
  return db.lock(groups.name, rebuild);
}
