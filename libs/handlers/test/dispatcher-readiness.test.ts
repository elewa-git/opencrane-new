import { expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { natsFixture } from '@opencrane/event-store/testing';
import { pgDb } from '@opencrane/projections';
import { Pool } from 'pg';
import { dispatch, provisionDispatcher } from '../src/dispatcher.ts';
import { HandlerRuntime } from '../src/queue.ts';
import { logger } from './helpers.ts';

it('withdraws readiness while a failed dispatch waits for database unlock', async () => {
  const nats = await natsFixture();
  const directory = await mkdtemp(`${tmpdir()}/dispatcher-readiness-`);
  const marker = `${directory}/ready`;
  await writeFile(marker, String(process.pid));
  const unlockStarted = Promise.withResolvers<void>();
  const releaseUnlock = Promise.withResolvers<void>();
  const state = { silo: 'test', manifest: '[]', sequence: '0' };
  const client = {
    on() {},
    removeListener() {},
    release() {},
    async query(query: string | { text: string }) {
      const sql = typeof query === 'string' ? query : query.text;
      if (sql.includes('pg_advisory_unlock')) {
        unlockStarted.resolve();
        await releaseUnlock.promise;
      }
      return { rows: [] };
    },
  };
  const pool = Object.assign(new Pool(), {
    query(sql: string) {
      if (sql.startsWith('SELECT silo, manifest, sequence')) {
        return Promise.resolve({ rows: [state] });
      }
      return Promise.resolve({ rows: [] });
    },
    connect() {
      return Promise.resolve(client);
    },
  });
  const db = pgDb(pool);
  const runtime = new HandlerRuntime({ db, logger, silo: 'test', handlers: [] });
  let ready = false;
  let readinessRemoval: Promise<void> | undefined;
  const stop = new AbortController();
  function withdrawReadiness() {
    readinessRemoval = rm(marker, { force: true });
  }
  stop.signal.addEventListener('abort', withdrawReadiness, { once: true });
  async function markReady() {
    ready = true;
    await nats.dispatcherConnection.close();
  }
  function dispatchFailed() {
    stop.abort();
  }
  await provisionDispatcher(nats.connection);
  const task = dispatch(nats.dispatcherConnection, runtime, stop.signal,
    markReady, dispatchFailed);
  void task.catch(() => undefined);
  try {
    await unlockStarted.promise;
    expect(ready).toBe(true);
    await readinessRemoval;
    await expect(readFile(marker)).rejects.toThrow('ENOENT');
  } finally {
    releaseUnlock.resolve();
    await task.catch(() => undefined);
    await nats.close();
    await pool.end();
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);
