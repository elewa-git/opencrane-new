import { afterEach, expect, it } from 'vitest';
import { PgBoss, TestClock, type Db } from 'pg-boss';
import { scheduleNightly } from '../src/nightly.ts';
import { fixture, until } from './helpers.ts';

let services: Awaited<ReturnType<typeof fixture>>;
const schedulers: PgBoss[] = [];
afterEach(async function close() {
  for (const scheduler of schedulers) await scheduler.stop();
  schedulers.length = 0;
  await services?.close();
});
it('uses the native UTC schedule with one trigger across two timekeepers at 02:00',
  async function nativeBoundary() {
    services = await fixture();
    const clock = new TestClock('2026-10-12T01:59:59Z');
    let sessionStatements: string[] = [];
    async function setSessionStatements(statements: string[]) { sessionStatements = statements; }
    async function executeSql(sql: string, values?: unknown[]) {
      const client = await services.pool.connect();
      try {
        for (const statement of sessionStatements) await client.query(statement);
        return await client.query(sql, values);
      } finally { client.release(); }
    }
    const adapter: Db = { executeSql, setSessionStatements };
    for (let index = 0; index < 2; index++) {
      const scheduler = new PgBoss({ db: adapter, clock,
        cronMonitorIntervalSeconds: 1, supervise: false });
      schedulers.push(scheduler);
      await scheduler.start();
    }
    let delivered = 0;
    async function record() { delivered++; }
    await scheduleNightly(schedulers[0]!, 'test', record);
    const schedule = await schedulers[0]!.getSchedule('dream-nightly', 'test');
    expect(schedule).toMatchObject({ cron: '0 2 * * *', timezone: 'UTC',
      options: { missed: 'skip' } });
    expect(delivered).toBe(0);
    await clock.tick(1000);
    await clock.tick(3000);
    async function received() { return delivered === 1; }
    await until(received);
    await clock.tick(60_000);
    expect(delivered).toBe(1);
  }, 30_000);
