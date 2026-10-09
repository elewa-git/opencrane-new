import { parseArgs } from 'node:util';
import { createLogger } from '@opencrane/observability';
import { connectProjectionDb, type Query } from '@opencrane/projections';

/** List lasting failures or deliberately stop retrying one failed original. */
export async function jobsCommand(arguments_: string[]): Promise<void> {
  const options = { cancel: { type: 'string' } } as const;
  const args = parseArgs({ args: arguments_, options });
  const connectionString = process.env['DATABASE_URL'];
  if (!connectionString) {
    throw new Error('DATABASE_URL is required');
  }
  const logger = createLogger('jobs');
  function databaseError(error: Error) {
    logger.error({ err: error }, 'Job command database connection failed');
    process.exitCode = 1;
  }
  const database = connectProjectionDb(connectionString, databaseError);
  try {
    const id = args.values.cancel;
    if (id) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(id)) {
        throw new Error('A failed job id must be a UUID');
      }
      async function cancel(tx: Query) {
        const result = await tx.query(
          "UPDATE pgboss.job SET state = 'cancelled', completed_on = now() " +
          "WHERE id = $1 AND state = 'failed' AND name NOT LIKE '%-dead' RETURNING id, name",
          [id],
        );
        if (result.rows.length !== 1) {
          throw new Error('No failed job was found with that id');
        }
        return result.rows[0];
      }
      const cancelled = await database.db.transaction(cancel);
      console.log(JSON.stringify({ cancelled }));
      return;
    }
    const result = await database.db.query(
      "SELECT id, name, singleton_key AS stream, retry_count, output FROM pgboss.job " +
      "WHERE state = 'failed' AND name NOT LIKE '%-dead' ORDER BY name, created_on",
    );
    console.log(JSON.stringify({ failedJobs: result.rows }));
  } finally {
    await database.close();
  }
}
