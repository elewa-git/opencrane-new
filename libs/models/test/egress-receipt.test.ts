import { expect, it } from 'vitest';
import { history } from '../src/event-history.ts';
import { egressFixture } from './egress-fixture.ts';
import { clientHello } from './egress-hello-fixture.ts';

async function normalClose() {
  const setup = await egressFixture(true, true);
  const observationId = setup.receipt.observationId;
  await setup.tunnel(await setup.token(), 'registry.npmjs.org:443', clientHello());
  function closed() { return setup.closeRecords.length; }
  await expect.poll(closed).toBe(1);
  expect(await setup.receipt.retry()).toBe('saved');
  const rows = await history(setup.store, `egress-${observationId}`, 'test');
  expect(rows).toHaveLength(1);
  expect(rows[0]?.event).toMatchObject({ id: observationId, type: 'egress.observed',
    data: { outcome: 'unknown', relay: { reason: 'finished', address: '1.1.1.1',
      host: 'registry.npmjs.org', port: 443, bytesSent: clientHello().length,
      bytesReceived: clientHello().length } } });
  expect(JSON.stringify(rows)).not.toContain('secret-canary');
}
it('saves one durable close receipt from the pinned gateway', normalClose);
