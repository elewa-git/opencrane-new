import { afterAll, describe, expect, it } from 'vitest';
import { startPg, type TestPg } from '../../src/pg.ts';
import { startBoss, stopBoss, type TestBoss } from '../../src/pgboss-util.ts';

describe('smoke: embedded PostgreSQL and pg-boss start without Docker', () => {
  let tpg: TestPg | undefined;
  let t: TestBoss | undefined;

  afterAll(async () => {
    await stopBoss(t);
    await tpg?.stop();
  });

  it('starts a real local PostgreSQL and a pg-boss instance, and moves one job through it', async () => {
    tpg = await startPg('smoke');
    t = await startBoss(tpg.connectionString);
    await t.boss.createQueue('smoke-queue');
    const id = await t.boss.send('smoke-queue', { hello: 'world' });
    expect(id).toBeTruthy();
    const [job] = await t.boss.fetch<{ hello: string }>('smoke-queue', { batchSize: 1 });
    expect(job?.data).toEqual({ hello: 'world' });
    expect(t.errors).toEqual([]);
  }, 60_000);
});
