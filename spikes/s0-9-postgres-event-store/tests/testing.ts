import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { vi } from 'vitest';
import type { NatsConnection } from '@nats-io/transport-node';
import type { EventEnvelope } from '@opencrane/events';
import { event } from '@opencrane/event-store/testing';
import type { StoredEvent } from '@opencrane/event-store';
import { PostgresEventStore } from '../src/postgres-event-store.ts';

export { event };

export async function natsFixture() {
  const connectionString = process.env['PG_TEST_URL'];
  if (!connectionString) throw new Error('Set PG_TEST_URL to the disposable test database');
  const admin = new Pool({ connectionString });
  const schema = `spike_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
  const store = new PostgresEventStore(pool);
  await store.ensureStream({ replicas: 1 });
  async function close() {
    vi.restoreAllMocks();
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
  async function seed(events: EventEnvelope[]) {
    for (const input of events) {
      // Retain old stored history, including repeated command keys, as the NATS fixture does.
      await pool.query(`INSERT INTO events SELECT COALESCE(MAX(position), 0) + 1, $1, $2
        FROM events`, [input.subject, input]);
    }
  }
  // Keep the copied, skipped transport tests type-checkable. No NATS connection is opened here.
  const connection = undefined as unknown as NatsConnection;
  async function stop() { throw new Error('NATS restart contract is not a PostgreSQL test'); }
  async function restart(_enabled = true) { await stop(); }
  return { store, pool, seed, close, connection, stop, restart };
}

export function countReads(store: Pick<PostgresEventStore, 'readStream'>) {
  const calls: { subject: string; fromSequence: number; rows: number }[] = [];
  const original = store.readStream.bind(store);
  async function* read(...args: Parameters<typeof original>): AsyncGenerator<StoredEvent> {
    const call = { subject: args[0], fromSequence: args[1] ?? 1, rows: 0 };
    calls.push(call);
    for await (const row of original(...args)) {
      call.rows += 1;
      yield row;
    }
  }
  vi.spyOn(store, 'readStream').mockImplementation(read);
  return { calls };
}
