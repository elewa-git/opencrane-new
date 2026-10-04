import type { Logger } from '@opencrane/observability';
import type { Db, Query } from './db.ts';
import { groups, replayGroups } from './groups.ts';
import { ProjectionRunner, type EventSource } from './runner.ts';

const tables = ['groups', 'group_members', 'group_access'];
async function removeReplay(tx: Query) {
  await replayGroups.drop(tx);
  for (const table of ['projection_events', 'projection_checkpoints', 'projection_generations']) {
    await tx.query(`DELETE FROM ${table} WHERE ${table === 'projection_events' ? 'projection' : 'name'} = $1`, [replayGroups.name]);
  }
}
async function state(db: Query, suffix: string) {
  return Promise.all(tables.map(async table => (await db.query(`SELECT * FROM ${table}${suffix} ORDER BY silo, group_id${table === 'group_members' ? ', member_id' : table === 'group_access' ? ', resource_type, resource_id, relation' : ''}`)).rows));
}
/** Rebuild beside the live tables; keep the existing grants and switch atomically. */
export async function rebuildGroupProjection(db: Db, source: EventSource, logger: Logger, { verify = false }: { verify?: boolean } = {}) {
  if (!db.lock) throw new Error('Group rebuild requires projection locking');
  return db.lock(groups.name, async locked => {
    const runner = new ProjectionRunner(locked, source, logger);
    await runner.initialise(groups);
    const checkpoint = await runner.checkpoint(groups);
    await locked.transaction(removeReplay);
    await runner.initialise(replayGroups);
    try {
      await runner.run(replayGroups, { toSequence: checkpoint });
      const unchanged = JSON.stringify(await state(locked, '')) === JSON.stringify(await state(locked, '_replay'));
      if (verify && !unchanged) throw new Error('Rebuilt groups differ from the live projection');
      const head = await source.head();
      await runner.run(replayGroups, { toSequence: head });
      await locked.transaction(async tx => {
        await tx.query("SET LOCAL lock_timeout = '250ms'");
        await tx.query(`LOCK TABLE ${tables.flatMap(table => [table, `${table}_replay`]).join(', ')} IN ACCESS EXCLUSIVE MODE`);
        await tx.query(`TRUNCATE ${tables.join(', ')}`);
        for (const table of tables) await tx.query(`INSERT INTO ${table} SELECT * FROM ${table}_replay`);
        await replayGroups.drop(tx);
        await tx.query('DELETE FROM projection_events WHERE projection = $1', [groups.name]);
        await tx.query('UPDATE projection_events SET projection = $1 WHERE projection = $2', [groups.name, replayGroups.name]);
        await tx.query('UPDATE projection_checkpoints SET sequence = $2 WHERE name = $1', [groups.name, head]);
        if (!unchanged) await tx.query('UPDATE projection_generations SET generation = generation + 1 WHERE name = $1', [groups.name]);
        for (const table of ['projection_checkpoints', 'projection_generations']) await tx.query(`DELETE FROM ${table} WHERE name = $1`, [replayGroups.name]);
      });
      return { previousSequence: checkpoint, sequence: head, verified: verify, changed: !unchanged };
    } catch (error) {
      await locked.transaction(removeReplay).catch((cleanupError: unknown) => { throw new AggregateError([error, cleanupError], 'Group rebuild and cleanup failed'); });
      throw error;
    }
  });
}
