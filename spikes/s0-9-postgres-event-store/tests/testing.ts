import { vi } from 'vitest';
import type { NatsConnection } from '@nats-io/transport-node';
import { event } from '@opencrane/event-store/testing';

import { postgresFixture } from '../src/postgres-fixture.ts';

export { event };
export { countReads } from '@opencrane/event-store/testing';

export async function natsFixture() {
  const connectionString = process.env['PG_TEST_URL'];
  if (!connectionString) throw new Error('Set PG_TEST_URL to the disposable test database');
  const fixture = await postgresFixture(connectionString);
  async function close() {
    vi.restoreAllMocks();
    await fixture.close();
  }
  // Keep the copied, skipped transport tests type-checkable. No NATS connection is opened here.
  const connection = undefined as unknown as NatsConnection;
  function stop(): Promise<never> {
    return Promise.reject(new Error('NATS restart contract is not a PostgreSQL test'));
  }
  function restart(_enabled = true) {
    void _enabled;
    return stop();
  }
  return { ...fixture, close, connection, stop, restart };
}
