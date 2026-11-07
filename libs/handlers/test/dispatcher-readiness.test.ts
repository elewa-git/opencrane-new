import { expect, it } from 'vitest';
import { natsFixture } from '@opencrane/event-store/testing';
import type { Db } from '@opencrane/projections';
import { dispatch, provisionDispatcher } from '../src/dispatcher.ts';
import type { HandlerRuntime } from '../src/queue.ts';
import { logger } from './helpers.ts';

it('withdraws readiness while a failed dispatch waits for database unlock', async () => {
  const nats = await natsFixture();
  const unlockStarted = Promise.withResolvers<void>();
  const releaseUnlock = Promise.withResolvers<void>();
  const state = { silo: 'test', manifest: '[]', sequence: '0' };
  const db = {
    async query(sql: string) {
      if (sql.startsWith('SELECT silo, manifest, sequence')) {
        return { rows: [state] };
      }
      return { rows: [] };
    },
    async lock(_name: string, work: (locked: Db) => Promise<unknown>) {
      try {
        return await work(db as Db);
      } finally {
        unlockStarted.resolve();
        await releaseUnlock.promise;
      }
    },
  } as Db;
  const runtime = { options: { db, logger, silo: 'test', handlers: [] } } as
    unknown as HandlerRuntime;
  let ready = false;
  let withdrawn = false;
  const stop = new AbortController();
  async function markReady() {
    ready = true;
    throw new Error('Event consumer failed during startup');
  }
  function dispatchFailed() {
    withdrawn = true;
    stop.abort();
  }
  await provisionDispatcher(nats.connection);
  const task = dispatch(nats.dispatcherConnection, runtime, stop.signal,
    markReady, dispatchFailed);
  void task.catch(() => undefined);
  try {
    await unlockStarted.promise;
    expect(ready).toBe(true);
    expect(withdrawn).toBe(true);
  } finally {
    releaseUnlock.resolve();
    await task.catch(() => undefined);
    await nats.close();
  }
}, 15_000);
