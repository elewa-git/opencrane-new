import { TimeoutError, type NatsConnection } from '@nats-io/transport-node';
import { afterEach, expect, it, vi } from 'vitest';
import { event, natsFixture } from './testing.ts';

let fixture: Awaited<ReturnType<typeof natsFixture>> | undefined;

async function closeFixture() {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await fixture?.close();
  fixture = undefined;
}
afterEach(closeFixture);

async function provisionWithSlowReply(requestSuffix: string) {
  const current = await natsFixture({ provision: false });
  fixture = current;
  const request = current.connection.request.bind(current.connection);
  const blocked = Promise.withResolvers<void>();
  const send: NatsConnection['request'] = function send(subject, data, options) {
    if (subject.endsWith(requestSuffix)) {
      current.pauseResponses(true);
      blocked.resolve();
    }
    return request(subject, data, options);
  };
  vi.spyOn(current.connection, 'request').mockImplementation(send);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  let failure: unknown;
  function observeFailure(error: unknown) {
    failure = error;
  }
  const pending = current.store.ensureStream({ replicas: 1 }).catch(observeFailure);
  await blocked.promise;
  // Hold a real reply beyond the read timeout without depending on host load.
  await vi.advanceTimersByTimeAsync(251);
  current.pauseResponses(false);
  await pending;
  expect(failure).toBeUndefined();
  vi.useRealTimers();
  vi.restoreAllMocks();
  const command = { event: event('after-provision'), expectedSequence: 0 };
  expect(await current.store.append(command)).toEqual({ status: 'appended', sequence: 1 });
}

const provisioningRequests = ['STREAM.INFO.EVENTS', 'STREAM.CREATE.EVENTS'];
it.each(provisioningRequests)(
  'provisions usable storage when %s takes longer than the read timeout',
  provisionWithSlowReply,
);

async function boundProvisioningOutage() {
  const current = await natsFixture({ provision: false });
  fixture = current;
  current.pauseResponses(true);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  let failure: unknown;
  function observeFailure(error: unknown) {
    failure = error;
  }
  const pending = current.store.ensureStream({ replicas: 1 }).catch(observeFailure);
  await vi.advanceTimersByTimeAsync(4_999);
  expect(failure).toBeUndefined();
  await vi.advanceTimersByTimeAsync(1);
  await pending;
  expect(failure).toBeInstanceOf(TimeoutError);
}
it('reports unavailable provisioning after the normal five-second management timeout',
  boundProvisioningOutage);
