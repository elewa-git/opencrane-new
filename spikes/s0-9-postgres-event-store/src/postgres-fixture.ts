import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { EventEnvelope } from '@opencrane/events';
import { PostgresEventStore } from './postgres-event-store.ts';

export async function postgresFixture(connectionString: string) {
  const adminOptions = { connectionString, connectionTimeoutMillis: 2000 };
  const admin = new Pool(adminOptions);
  const id = randomUUID();
  const schema = `spike_${id.replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const poolOptions = { connectionString, options: `-c search_path=${schema}`,
    connectionTimeoutMillis: 2000, max: 60 };
  const pool = new Pool(poolOptions);
  const store = new PostgresEventStore(pool);
  await store.ensureStream({ replicas: 1 });
  async function close() {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
  async function seed(events: EventEnvelope[]) {
    const client = await pool.connect();
    let committed = false;
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(1094)');
      await client.query(`INSERT INTO events
        SELECT COALESCE((SELECT MAX(position) FROM events), 0) + ordinal,
          value->>'subject', value
        FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY AS batch(value, ordinal)`,
      [JSON.stringify(events)]);
      await client.query('COMMIT');
      committed = true;
    } finally {
      client.release(!committed);
    }
  }
  return { store, pool, seed, close };
}
