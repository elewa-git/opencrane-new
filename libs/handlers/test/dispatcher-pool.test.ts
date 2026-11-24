import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { pgDb } from '@opencrane/projections';
import { dispatch, HandlerRuntime, registerHandler } from '../src/index.ts';
import { fixture, logger } from './helpers.ts';

function unusedReaction(): Promise<void> {
  return Promise.reject(new Error('This test dispatches jobs without starting reaction workers'));
}

async function dispatchWithoutSpareConnection() {
  const services = await fixture();
  const pool = new Pool({ connectionString: services.connectionString,
    max: 2, connectionTimeoutMillis: 1000 });
  const handler = registerHandler('update-openfga', unusedReaction);
  const runtime = new HandlerRuntime({ db: pgDb(pool), logger,
    silo: 'test', handlers: [handler] });
  const stop = new AbortController();
  const ready = Promise.withResolvers<void>();
  let task: Promise<void> | undefined;
  let busy: PoolClient | undefined;
  async function markReady() {
    // Keep the other connection busy, as a running reaction does under load.
    busy = await pool.connect();
    ready.resolve();
  }
  try {
    await runtime.start();
    task = dispatch(services.nats.dispatcherConnection, runtime, stop.signal, { ready: markReady });
    await Promise.race([ready.promise, task]);
    const id = randomUUID();
    const sequence = await services.append(id);
    await Promise.race([services.checkpoint(sequence), task]);
    const saved = await services.db.query<{ id: string; handler: string }>(
      "SELECT data->>'id' AS id, name AS handler FROM pgboss.job",
    );
    expect(saved.rows).toEqual([{ id, handler: 'update-openfga' }]);
    expect(pool.totalCount).toBe(2);
    expect(pool.waitingCount).toBe(0);
  } finally {
    stop.abort();
    busy?.release();
    if (task) await Promise.allSettled([task]);
    await runtime.stop();
    await pool.end();
    await services.close();
  }
}

it.skipIf(!process.env['PG_TEST_URL'])(
  'queues an event using the reserved dispatcher connection when the pool has no spare slot',
  dispatchWithoutSpareConnection,
);
