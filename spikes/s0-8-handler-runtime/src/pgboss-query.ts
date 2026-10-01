// Plain SQL against pg-boss's own tables. The visibility tests use this to
// show what an operator can see with nothing but a database connection.
import pg from 'pg';

export interface JobRow {
  id: string;
  name: string;
  state: string;
  retryCount: number;
  retryLimit: number;
  singletonKey: string | null;
  data: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  createdOn: Date;
  startedOn: Date | null;
  completedOn: Date | null;
  deadLetter: string | null;
  sourceName: string | null;
}

const COLUMNS = `id, name, state, retry_count as "retryCount", retry_limit as "retryLimit",
  singleton_key as "singletonKey", data, output,
  created_on as "createdOn", started_on as "startedOn", completed_on as "completedOn",
  dead_letter as "deadLetter", source_name as "sourceName"`;

/** Run one query on a fresh connection and close it again. */
export async function sql<T extends pg.QueryResultRow = pg.QueryResultRow>(
  connectionString: string,
  text: string,
  values: unknown[] = [],
): Promise<T[]> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const { rows } = await client.query<T>(text, values);
    return rows;
  } finally {
    await client.end();
  }
}

/** Every job row of a queue, oldest first. Optionally only one key's jobs. */
export async function queryJobs(
  connectionString: string,
  queueName: string,
  opts: { singletonKey?: string } = {},
): Promise<JobRow[]> {
  if (opts.singletonKey !== undefined) {
    return sql<JobRow>(
      connectionString,
      `SELECT ${COLUMNS} FROM pgboss.job WHERE name = $1 AND singleton_key = $2 ORDER BY created_on, id`,
      [queueName, opts.singletonKey],
    );
  }
  return sql<JobRow>(connectionString, `SELECT ${COLUMNS} FROM pgboss.job WHERE name = $1 ORDER BY created_on, id`, [
    queueName,
  ]);
}

/** Create a table in the test database. */
export async function exec(connectionString: string, text: string): Promise<void> {
  await sql(connectionString, text);
}
