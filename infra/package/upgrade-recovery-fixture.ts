import { expect } from 'vitest';
import { jetstream } from '@nats-io/jetstream';
import { createEventStore, wireSubject } from '@opencrane/event-store';
import type { EventEnvelope } from '@opencrane/events';
import { provisionRecoveryEventTarget } from './recovery-event-target.ts';
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
  // Count scanned events separately: memory events do not enqueue these handlers.
  expect(parked.rows.length).toBeGreaterThan(0);
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


export async function recoveryTarget() {
  const target = await provisionRecoveryEventTarget('test');
  const store = await createEventStore(target.connection);
  async function seed(events: EventEnvelope[]) {
    const client = jetstream(target.connection);
    for (const event of events) {
      await client.publish(wireSubject(event.subject), JSON.stringify(event),
        { msgID: event.id, expect: { streamName: 'EVENTS' } });
    }
  }
  return { ...target, store, reader: store, seed };
}
