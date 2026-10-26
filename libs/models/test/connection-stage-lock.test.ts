import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Pool } from 'pg';
import { databases } from '@opencrane/authz/testing';
import { pgDb, type Db } from '@opencrane/projections';
import { withConnectionStage } from '../src/connection-stage-lock.ts';
import { MemberAccessRefused } from '../src/member-authority.ts';

const profile = { siloId: 'test', userId: 'person', serverId: 'server', profileId: 'personal' };
let storage: Awaited<ReturnType<typeof databases>>;
async function initialise() {
  storage = await databases();
  await storage.queue.query('SELECT 1');
}
async function close() {
  await storage?.close();
}
beforeAll(initialise);
afterAll(close);

function diagnosticDatabase(): Db {
  const database = pgDb(storage.queue);
  const lock = database.lock!.bind(database);
  const initialPool = { total: storage.queue.totalCount, idle: storage.queue.idleCount,
    waiting: storage.queue.waitingCount };
  async function loggedLock<Result>(...args: Parameters<typeof lock<Result>>) {
    try {
      return await lock(...args);
    } catch (error) {
      // Print only this fixed adapter message, never a driver error or command value.
      if (error instanceof Error && error.message === 'Database lock acquisition expired') {
        console.error('TEST LOCK DIAGNOSTIC: Database lock acquisition expired', {
          initialPool, total: storage.queue.totalCount, idle: storage.queue.idleCount,
          waiting: storage.queue.waitingCount,
        });
      }
      throw error;
    }
  }
  return { ...database, lock: loggedLock };
}

async function schedulingDelayCase(delayMs: number, available: boolean) {
  const realTime = performance.now.bind(performance);
  let schedulingDelay = 0;
  function currentTime() {
    return realTime() + schedulingDelay;
  }
  function connectionDelivered() {
    // Model a loaded worker resuming after asking for an idle connection.
    schedulingDelay = delayMs;
  }
  function staged() {
    return Promise.resolve('staged');
  }
  const work = vi.fn(staged);
  const clock = vi.spyOn(performance, 'now');
  clock.mockImplementation(currentTime);
  storage.queue.once('acquire', connectionDelivered);
  try {
    const pending = withConnectionStage(diagnosticDatabase(), profile, work);
    if (available) {
      await expect(pending).resolves.toBe('staged');
      expect(work).toHaveBeenCalledTimes(1);
    } else {
      await expect(pending).rejects.toThrow(/^Connection coordination unavailable$/u);
      expect(work).not.toHaveBeenCalled();
    }
    expect(schedulingDelay).toBe(delayMs);
  } finally {
    storage.queue.removeListener('acquire', connectionDelivered);
    clock.mockRestore();
  }
}
it.each([[150, true], [1200, false]] as const)(
  'after %i ms of worker scheduling delay, lock availability is %s', schedulingDelayCase);

async function unavailableCoordination() {
  const privateError = new Error('private-driver-value');
  function unavailable(): Promise<never> {
    return Promise.reject(privateError);
  }
  const work = vi.fn();
  const database = { lock: unavailable };
  await expect(withConnectionStage(database, profile, work)).rejects.toThrow(
    /^Connection coordination unavailable$/u);
  expect(work).not.toHaveBeenCalled();
}
it('refuses a database error without exposing its details or starting work', unavailableCoordination);

async function commandRefusal() {
  const refusal = new Error('Selection access unavailable');
  function refused(): Promise<never> {
    return Promise.reject(refusal);
  }
  await expect(withConnectionStage(pgDb(storage.queue), profile, refused)).rejects.toBe(refusal);
}
it('preserves a refusal from the command after acquiring its lock', commandRefusal);

type CoordinationFailure = 'unlock' | 'reset' | 'session loss';

function failingCoordination(failure: CoordinationFailure) {
  const client = new EventEmitter();
  const driverError = new Error('private-driver-value');
  function query(statement: string | { text: string }) {
    const sql = typeof statement === 'string' ? statement : statement.text;
    if (failure === 'unlock' && sql.includes('pg_advisory_unlock')) {
      return Promise.reject(driverError);
    }
    if (failure === 'reset' && sql === 'RESET lock_timeout') {
      return Promise.reject(driverError);
    }
    return Promise.resolve({ rows: [] });
  }
  const release = vi.fn();
  const connection = Object.assign(client, { query, release });
  function connect() {
    return Promise.resolve(connection);
  }
  function loseSession() {
    if (failure === 'session loss') {
      client.emit('error', driverError);
    }
  }
  const pool = { connect } as unknown as Pool;
  return { database: pgDb(pool), release, loseSession };
}

async function commandRefusalSurvives(failure: CoordinationFailure) {
  const fixture = failingCoordination(failure);
  const refusal = new MemberAccessRefused('Active silo membership required');
  async function refused() {
    fixture.loseSession();
    throw refusal;
  }
  const pending = withConnectionStage(fixture.database, profile, refused);
  await expect(pending).rejects.toBe(refusal);
  expect(fixture.release).toHaveBeenCalledExactlyOnceWith(true);
}
const coordinationFailures = ['unlock', 'reset', 'session loss'] as const;
it.each(coordinationFailures)(
  'preserves the original access refusal after %s fails', commandRefusalSurvives);

async function successfulWorkRefused(failure: CoordinationFailure) {
  const fixture = failingCoordination(failure);
  function staged() {
    fixture.loseSession();
    return Promise.resolve('staged');
  }
  const work = vi.fn(staged);
  const pending = withConnectionStage(fixture.database, profile, work);
  await expect(pending).rejects.toThrow(/^Connection coordination unavailable$/u);
  expect(work).toHaveBeenCalledTimes(1);
  expect(fixture.release).toHaveBeenCalledExactlyOnceWith(true);
}
it.each(coordinationFailures)(
  'refuses successful work after %s fails', successfulWorkRefused);
