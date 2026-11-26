import type { Query } from './db.ts';

const schema = 'opencrane_memory';

export function memoryProjectionDatabaseUrl(databaseUrl: string) {
  const setting = process.env['MEMORY_PROJECTION_SCHEMA'];
  if (setting === undefined) return undefined;
  if (setting !== schema) throw new Error('Invalid Memory projection schema');
  const url = new URL(databaseUrl);
  const existingOptions = url.searchParams.get('options');
  let options = `-c search_path=${schema},public`;
  if (existingOptions) options = `${existingOptions} ${options}`;
  url.searchParams.set('options', options);
  return url.href;
}

export async function initialiseMemoryProjectionSchema(db: Query) {
  // Keep these rebuildable tables out of the public tables checked during pilot restore.
  await db.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
  await db.query(`GRANT USAGE ON SCHEMA ${schema} TO server`);
  await db.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT SELECT ON TABLES TO server`);
}
