import type { Query } from '@opencrane/projections';

export async function sessionDiagnostics(db: Query, databaseName?: string) {
  // Exclude query text and application names because clients can put secrets in either field.
  const sessions = await db.query(
    'SELECT pid, backend_type, state, wait_event_type, backend_start, ' +
      'xact_start, query_start, state_change FROM pg_stat_activity ' +
      'WHERE datname = COALESCE($1, current_database()) AND pid <> pg_backend_pid() ' +
      'ORDER BY backend_start',
    [databaseName ?? null],
  );
  return sessions.rows;
}
