import { JetStreamApiError } from '@nats-io/jetstream';
import { expect, it, vi } from 'vitest';
import { waitForClusterStream } from './cluster-stream.ts';

const peerOffline = 'no suitable peers for placement, peer offline';

async function waitsForPlacementStatistics() {
  const unavailable = new JetStreamApiError({
    code: 400, err_code: 10005, description: peerOffline,
  });
  const ensureStream = vi.fn();
  ensureStream.mockRejectedValueOnce(unavailable);
  ensureStream.mockResolvedValue(undefined);
  await waitForClusterStream({ ensureStream });
  expect(ensureStream).toHaveBeenCalledTimes(2);
  expect(ensureStream).toHaveBeenLastCalledWith({ replicas: 3 });
}
it('waits when routed metadata peers still lack placement statistics', waitsForPlacementStatistics);

const failures = [
  new Error('timeout'),
  new Error('Incompatible stream num_replicas'),
  new JetStreamApiError({ code: 403, err_code: 10005, description: peerOffline }),
  new JetStreamApiError({ code: 400, err_code: 10023, description: peerOffline }),
  new JetStreamApiError({
    code: 400, err_code: 10005,
    description: 'no suitable peers for placement, insufficient storage',
  }),
];

async function preservesOtherFailures(error: Error) {
  const ensureStream = vi.fn();
  ensureStream.mockRejectedValueOnce(error);
  ensureStream.mockResolvedValue(undefined);
  await expect(waitForClusterStream({ ensureStream })).rejects.toBe(error);
  expect(ensureStream).toHaveBeenCalledTimes(1);
}
it.each(failures)('preserves a non-readiness failure: %s', preservesOtherFailures);
