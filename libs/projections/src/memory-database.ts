import type { Query } from './db.ts';

export const memoryProjectionSchema = 'opencrane_memory';

export function memoryProjectionDatabaseUrl(databaseUrl: string) {
  // Reject malformed addresses without attaching the supplied credentials to the error.
  if (!URL.canParse(databaseUrl)) {
    throw new Error('Invalid Memory database address');
  }
  const url = new URL(databaseUrl);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new Error('Invalid Memory database address');
  }
  const setting = process.env['MEMORY_PROJECTION_SCHEMA'];
  if (setting === undefined) {
    return undefined;
  }
  if (setting !== memoryProjectionSchema) {
    throw new Error('Invalid Memory projection schema');
  }
  const existingOptions = url.searchParams.get('options');
  // Find Memory tables first and keep shared chat and group tables in public.
  const searchPath = `-c search_path=${memoryProjectionSchema},public`;
  let options = searchPath;
  if (existingOptions) {
    options = `${existingOptions} ${searchPath}`;
  }
  url.searchParams.set('options', options);
  return url.href;
}

export async function initialiseMemoryProjectionSchema(db: Query) {
  // Keep these rebuildable tables out of the public tables checked during pilot restore.
  await db.query(`CREATE SCHEMA IF NOT EXISTS ${memoryProjectionSchema}`);
  await db.query(`GRANT USAGE ON SCHEMA ${memoryProjectionSchema} TO server`);
  await db.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${memoryProjectionSchema}
    GRANT SELECT ON TABLES TO server`);
}
