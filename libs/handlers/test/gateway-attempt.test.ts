import { Pool } from 'pg';
import { databases } from '@opencrane/authz/testing';
import { pgDb, type Query } from '@opencrane/projections';
import { expect, it, onTestFinished } from 'vitest';
import { withinAttempt } from '../src/attempt.ts';

async function releasesExpiredLock() {
  const storage = await databases();
  onTestFinished(storage.close.bind(storage));
  const db = pgDb(storage.queue);
  const controller = new AbortController();
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  let preparation: Promise<void> | undefined;
  async function attempt(_query: Query, context?: { signal: AbortSignal; deadline: number }) {
    async function prepare() {
      entered.resolve();
      const stopped = Promise.withResolvers<void>();
      function cancel() { stopped.resolve(); }
      context?.signal.addEventListener('abort', cancel, { once: true });
      try {
        await Promise.race([finish.promise, stopped.promise]);
      } finally {
        context?.signal.removeEventListener('abort', cancel);
      }
    }
    const options = { timeoutMs: 200, signal: context?.signal };
    preparation = db.lock!('gateway-configuration:test', prepare, options);
    await preparation;
  }
  const pending = withinAttempt(db, controller.signal, 60, attempt);
  const result = pending.catch(function failed(error: unknown) { return error; });
  await entered.promise;
  controller.abort(new Error('Attempt expired'));
  expect(await result).toMatchObject({ message: 'Handler attempt aborted' });
  async function locks() {
    const result = await storage.queue.query(`SELECT pid FROM pg_locks
      WHERE locktype = 'advisory' AND granted
      AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`);
    return result.rowCount;
  }
  try {
    await expect.poll(locks, { timeout: 500 }).toBe(0);
  } finally {
    finish.resolve();
    await preparation;
  }
}
it('passes attempt cancellation to preparation so it releases the content lock',
  releasesExpiredLock);

async function boundsPoolAcquisition() {
  const storage = await databases();
  onTestFinished(storage.close.bind(storage));
  const pool = new Pool({ connectionString: storage.queue.options.connectionString, max: 1 });
  const occupied = await pool.connect();
  let called = false;
  let settled = false;
  async function prepare() { called = true; }
  function completed(error?: unknown) { settled = true; return error; }
  const pending = pgDb(pool).lock!('gateway-configuration:test', prepare, { timeoutMs: 100 });
  const result = pending.then(completed, completed);
  function finished() { return settled; }
  try {
    await expect.poll(finished, { timeout: 500 }).toBe(true);
    expect(await result).toBeInstanceOf(Error);
  } finally {
    occupied.release();
    await result;
    await pool.end();
  }
  expect(called).toBe(false);
}
it('bounds gateway lock acquisition even when every pooled connection is occupied',
  boundsPoolAcquisition);
