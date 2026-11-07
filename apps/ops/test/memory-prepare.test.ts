import { createServer } from 'node:http';
import { once } from 'node:events';
import { expect, it, vi } from 'vitest';
import { event } from '@opencrane/event-store/testing';
import type { EventEnvelope } from '@opencrane/events';
import type { Query } from '@opencrane/projections';
import { maintenanceOrChildRoute } from '../../../libs/models/src/decision-maintenance.ts';
import { memoryPrepareHandler } from '../src/memory-prepare.ts';

it('sends a due night through the worker and decision HTTP route', async function wiredPreparation() {
  const scopeId = 'd'.repeat(64);
  const nightId = 'a'.repeat(64);
  const preparation = vi.fn(function prepare(receivedScope: string,
    receivedNight: string) {
    expect(receivedScope).toBe(scopeId);
    expect(receivedNight).toBe(nightId);
    return Promise.resolve({ outcome: 'refused' });
  });
  const transaction: Query = {
    query() { throw new Error('Unexpected database query'); },
  };
  const identity = { jwks: { keys: [] }, issuer: 'test' };
  function receive(request: Parameters<typeof maintenanceOrChildRoute>[0],
    response: Parameters<typeof maintenanceOrChildRoute>[1]) {
    void maintenanceOrChildRoute(request, response, 'acme', identity,
      undefined, preparation);
  }
  const server = createServer(receive);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server unavailable');
    const handler = memoryPrepareHandler(`http://127.0.0.1:${address.port}`);
    const saved = { ...event('prepare-http', `scope-${scopeId}`),
      type: 'memory.maintenance_recorded', source: 'opencrane-nightly',
      data: { scopeId, nightId, batchKey: 'b'.repeat(64), inputRevision: 'c'.repeat(64),
        date: '2026-10-12', bindingRevision: 1, memberId: 'dreamer', acceptedCapCents: 100,
        intendedAt: '2026-10-12T02:00:00.000Z', selectedAt: '2026-10-12T02:00:01.000Z',
        inputRefs: [], action: 'due', reason: null } } as EventEnvelope;
    await handler.handle(saved, transaction);
    expect(preparation).toHaveBeenCalledExactlyOnceWith(scopeId, nightId);
  } finally {
    server.close();
    await once(server, 'close');
  }
});
