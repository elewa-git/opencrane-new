import { JetStreamApiError } from '@nats-io/jetstream';
import { afterEach, expect, it, vi } from 'vitest';
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
  new Error(peerOffline),
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

function promiseTimers() {
  function delay(milliseconds: number) {
    function schedule(resolve: () => void) {
      setTimeout(resolve, milliseconds);
    }
    return new Promise<void>(schedule);
  }
  return { setTimeout: delay };
}
vi.mock('node:timers/promises', promiseTimers);

function restoreClock() {
  vi.useRealTimers();
}
afterEach(restoreClock);

async function waitsForLatePlacementStatistics() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval',
    'clearInterval', 'performance'] });
  const refusal = new JetStreamApiError({
    code: 400, err_code: 10005, description: peerOffline,
  });
  function ensureStream() {
    if (performance.now() < 6000) {
      return Promise.reject(refusal);
    }
    return Promise.resolve();
  }
  let failure: unknown;
  function recordFailure(error: unknown) {
    failure = error;
  }
  const pending = waitForClusterStream({ ensureStream }).catch(recordFailure);
  await vi.advanceTimersByTimeAsync(6000);
  await pending;
  expect(failure).toBeUndefined();
}
it('waits for observed placement refusals beyond the former five-second fixture limit',
  waitsForLatePlacementStatistics);

async function reportsPlacementRefusalAtDeadline() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval',
    'clearInterval', 'performance'] });
  const refusal = new JetStreamApiError({
    code: 400, err_code: 10005, description: peerOffline,
  });
  const ensureStream = vi.fn();
  ensureStream.mockRejectedValue(refusal);
  let failure: unknown;
  function recordFailure(error: unknown) {
    failure = error;
  }
  const pending = waitForClusterStream({ ensureStream }).catch(recordFailure);
  await vi.advanceTimersByTimeAsync(19_999);
  expect(failure).toBeUndefined();
  await vi.advanceTimersByTimeAsync(1);
  await pending;
  expect(failure).toHaveProperty('message', expect.stringContaining(peerOffline));
  expect(failure).toHaveProperty('message', expect.stringContaining('20000 ms'));
  expect(failure).toHaveProperty('cause', refusal);
}
it('reports the last observed placement refusal at the bounded fixture deadline',
  reportsPlacementRefusalAtDeadline);

async function boundsAnUnansweredPlacementRequest() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const unresolved = Promise.withResolvers<void>();
  const ensureStream = vi.fn();
  ensureStream.mockReturnValue(unresolved.promise);
  let failure: unknown;
  function recordFailure(error: unknown) {
    failure = error;
  }
  const pending = waitForClusterStream({ ensureStream }).catch(recordFailure);
  await vi.advanceTimersByTimeAsync(19_999);
  expect(failure).toBeUndefined();
  await vi.advanceTimersByTimeAsync(1);
  expect(failure).toBeInstanceOf(Error);
  expect(failure).toHaveProperty('message', expect.stringContaining('20000 ms'));
  expect(ensureStream).toHaveBeenCalledTimes(1);
  unresolved.resolve();
  await pending;
}
it('bounds an unanswered placement request without retrying an unknown result',
  boundsAnUnansweredPlacementRequest);
