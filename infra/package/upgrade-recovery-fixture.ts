import { expect } from 'vitest';
import { HandlerRuntime, upgradeHandlers } from '@opencrane/handlers';
import type { fixture } from '../../libs/handlers/test/helpers.ts';

type SourceFixture = Awaited<ReturnType<typeof fixture>>;

export async function interruptAndRefuse(source: SourceFixture, runtime: HandlerRuntime,
  effectUrl: string, previous: string, sequence: number) {
  await runtime.stop();
  await source.waitForConnectionsClosed();
  await source.crash('upgrade-after-chunk', effectUrl);
  const progress = await source.db.query('SELECT previous, manifest, target, sequence FROM handler_upgrade');
  expect(progress.rows).toMatchObject([{ previous, target: String(sequence), sequence: '256' }]);
  const parked = await source.db.query('SELECT * FROM pgboss.job ORDER BY name, id');
  expect(parked.rows.length).toBeGreaterThan(256);
  for (const row of parked.rows) expect(row['start_after']).toBe(Infinity);
  const incompatible = new HandlerRuntime({ ...runtime.options, handlers: [] });
  await source.waitForConnectionsClosed();
  await expect(upgradeHandlers(incompatible, source.nats.reader))
    .rejects.toThrow('unfinished upgrade uses different subscriptions');
  expect((await source.db.query('SELECT * FROM pgboss.job ORDER BY name, id')).rows)
    .toEqual(parked.rows);
  expect((await source.db.query('SELECT previous, manifest, target, sequence FROM handler_upgrade')).rows)
    .toEqual(progress.rows);
  return { progress, parked };
}

