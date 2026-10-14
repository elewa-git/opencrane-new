import { describe, expect, it, vi } from 'vitest';
import { requireOnlySession } from '../src/upgrade-scan.ts';

function databaseWithSession(backendType: string | null) {
  const rows = [{ backend_type: backendType }];
  const query = vi.fn().mockResolvedValue({ rows });
  return { query };
}

describe('handler upgrade database sessions', () => {
  it('allows PostgreSQL maintenance in the handlers database', async () => {
    const database = databaseWithSession('autovacuum worker');
    await expect(requireOnlySession(database)).resolves.toBeUndefined();
  });

  async function refusesUnsafeBackend(backendType: string | null) {
    const database = databaseWithSession(backendType);
    await expect(requireOnlySession(database)).rejects.toThrow('other database sessions');
  }
  it.each(['logical replication worker', 'extension worker', null, 'startup'])(
    'refuses a backend that is not known to be safe: %s', refusesUnsafeBackend,
  );

  it('still refuses another database client', async () => {
    const database = databaseWithSession('client backend');
    await expect(requireOnlySession(database)).rejects.toThrow('other database sessions');
  });
});
