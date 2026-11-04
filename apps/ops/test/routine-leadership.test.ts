import { expect, it, onTestFinished } from 'vitest';
import { connectProjectionDb } from '@opencrane/projections';
import { withRoutineLeadership } from '../src/routine-leadership.ts';

const databaseUrl = process.env['PG_TEST_URL']!;
type Leadership = Parameters<Parameters<typeof withRoutineLeadership>[1]>[0];

async function owner(silo = 'test') {
  const ready = Promise.withResolvers<Leadership>();
  const finish = Promise.withResolvers<void>();
  const stop = new AbortController();
  async function work(lease: Leadership) {
    ready.resolve(lease);
    await finish.promise;
  }
  const options = { databaseUrl, silo, signal: stop.signal };
  const done = withRoutineLeadership(options, work);
  void done.catch(ready.reject);
  async function close() {
    stop.abort();
    finish.resolve();
    await done;
  }
  onTestFinished(close);
  const lease = await ready.promise;
  return { lease, close, stop, finish, done };
}

function ignoreError() {}
async function excludesOnlyItsSilo() {
  const first = await owner();
  expect(await first.lease.checkCurrent(performance.now() + 2000)).toBe(true);
  const other = await owner('other');
  expect(await other.lease.checkCurrent(performance.now() + 2000)).toBe(true);
  const database = connectProjectionDb(databaseUrl, ignoreError);
  onTestFinished(database.close);
  async function budget() {
    expect(await first.lease.checkCurrent(performance.now() + 2000)).toBe(true);
  }
  await database.db.lock!('budget-leader:test', budget, { timeoutMs: 1000 });
  const entered = Promise.withResolvers<void>();
  async function replacement(lease: Leadership) {
    expect(await first.lease.checkCurrent(performance.now() + 2000)).toBe(false);
    expect(await lease.checkCurrent(performance.now() + 2000)).toBe(true);
    entered.resolve();
  }
  const stop = new AbortController();
  const options = { databaseUrl, silo: 'test', signal: stop.signal };
  const next = withRoutineLeadership(options, replacement);
  void next.catch(entered.reject);
  await first.close();
  await entered.promise;
  await next;
}
it('holds one routine owner per silo independently of budget leadership', excludesOnlyItsSilo);
