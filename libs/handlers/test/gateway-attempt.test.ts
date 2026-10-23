import { Pool } from 'pg';
import { databases } from '@opencrane/authz/testing';
import { pgDb, type Query } from '@opencrane/projections';
import { expect, it, onTestFinished } from 'vitest';
import { withinAttempt } from '../src/attempt.ts';
import { registerHandler, type HandlerAttempt } from '../src/index.ts';
import { fixture, until } from './helpers.ts';

async function releasesExpiredLock() {
  const storage = await databases();
  onTestFinished(storage.close.bind(storage));
  const db = pgDb(storage.queue);
  const controller = new AbortController();
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  let preparation: Promise<void> | undefined;
  let preparationStopped = false;
  async function attempt(_query: Query, context?: { signal: AbortSignal; deadline: number }) {
    async function prepare() {
      entered.resolve();
      const stopped = Promise.withResolvers<void>();
      function cancel() {
        stopped.resolve();
      }
      context?.signal.addEventListener('abort', cancel, { once: true });
      try {
        await Promise.race([finish.promise, stopped.promise]);
      } finally {
        context?.signal.removeEventListener('abort', cancel);
        preparationStopped = true;
      }
    }
    const options = { timeoutMs: 200, ...(context ? { signal: context.signal } : {}) };
    preparation = db.lock!('gateway-configuration:test', prepare, options);
    await preparation;
  }
  const pending = withinAttempt(db, controller.signal, 60, attempt);
  function failed(error: unknown) {
    return error;
  }
  const result = pending.catch(failed);
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
    expect(preparationStopped).toBe(true);
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
  function prepare() {
    called = true;
    return Promise.resolve();
  }
  function completed(error?: unknown) {
    settled = true;
    return error;
  }
  const pending = pgDb(pool).lock!('gateway-configuration:test', prepare, { timeoutMs: 100 });
  const result = pending.then(completed, completed);
  function finished() {
    return settled;
  }
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

async function forwardsAttemptLimits() {
  const setup = await fixture();
  onTestFinished(setup.close);
  let called = false;
  let limits: HandlerAttempt | undefined;
  let abortedDuringHandler: boolean | undefined;
  async function handle(_event: unknown, transaction: Query, attempt?: HandlerAttempt) {
    limits = attempt;
    abortedDuringHandler = attempt?.signal.aborted;
    await transaction.query('SELECT 1');
    called = true;
  }
  const handler = registerHandler('update-members', handle);
  const runtime = await setup.runtime([handler]);
  await setup.append('attempt-limits');
  void setup.startDispatch(runtime);
  await setup.checkpoint(1);
  const started = performance.now();
  await runtime.work();
  function completed() {
    return Promise.resolve(called);
  }
  await until(completed);
  expect(limits?.signal).toBeInstanceOf(AbortSignal);
  expect(abortedDuringHandler).toBe(false);
  expect(limits?.deadline).toBeGreaterThan(started);
  expect(limits?.deadline).toBeLessThanOrEqual(performance.now() + 60_000);
}
it('passes the live job attempt limits through the runtime to its handler', forwardsAttemptLimits);

async function preservesCallbackLockTimeout() {
  const storage = await databases();
  onTestFinished(storage.close.bind(storage));
  const pool = new Pool({ connectionString: storage.queue.options.connectionString, max: 1 });
  const db = pgDb(pool);
  async function readTimeout(connection: Query) {
    const result = await connection.query<{ lock_timeout: string }>('SHOW lock_timeout');
    return result.rows[0]!.lock_timeout;
  }
  try {
    const before = await readTimeout(db);
    const options = { timeoutMs: 250 };
    const during = await db.lock!('gateway-configuration:test', readTimeout, options);
    expect(during).toBe('250ms');
    expect(await readTimeout(db)).toBe(before);
  } finally {
    await pool.end();
  }
}
it('keeps the caller lock timeout during work and resets it before reusing the connection',
  preservesCallbackLockTimeout);
