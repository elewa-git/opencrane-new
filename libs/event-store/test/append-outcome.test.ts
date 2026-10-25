import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { jetstream, jetstreamManager, type JetStreamClient } from '@nats-io/jetstream';
import { TimeoutError } from '@nats-io/transport-node';
import { EventStore } from '../src/index.ts';
import { event, natsFixture } from './testing.ts';

let fixture: Awaited<ReturnType<typeof natsFixture>>;
let store: EventStore;
let client: JetStreamClient;

async function setup() {
  fixture = await natsFixture();
  client = jetstream(fixture.connection);
  const manager = await jetstreamManager(fixture.connection);
  store = new EventStore(client, manager);
}
async function close() {
  vi.restoreAllMocks();
  await fixture?.close();
}
beforeEach(setup);
afterEach(close);

async function distinguishesSavedCommands() {
  const command = { event: event('saved'), expectedSequence: 0, historyChecked: true as const };
  expect(await store.appendOutcome(command)).toEqual({ status: 'appended', sequence: 1 });
  expect(await store.appendOutcome(command)).toEqual({ status: 'duplicate_saved', sequence: 1 });
  const retry = { ...command, historyChecked: undefined };
  expect(await store.appendOutcome(retry)).toEqual({ status: 'duplicate_saved', sequence: 1 });
  expect(await store.head()).toBe(1);
}
it('distinguishes a new append from a duplicate already saved', distinguishesSavedCommands);

async function reportsChangedState() {
  await fixture.store.append({ event: event('earlier'), expectedSequence: 0 });
  const command = { event: event('stale'), expectedSequence: 0, historyChecked: true as const };
  expect(await store.appendOutcome(command)).toEqual({ status: 'conditional_rejection_changed' });
  expect(await store.head()).toBe(1);
}
it('reports a conditional rejection with the subject confirmed changed', reportsChangedState);

async function saveUnrelated() {
  const input = event('unrelated', 'member-bob');
  expect(await fixture.store.append({ event: input, expectedSequence: 0 }))
    .toEqual({ status: 'appended', sequence: 1 });
}
async function reportsUnchangedState() {
  const command = { event: event('unchanged'), expectedSequence: 0,
    historyChecked: true as const, checkAccess: saveUnrelated };
  expect(await store.appendOutcome(command)).toEqual({ status: 'conditional_rejection_unchanged' });
  expect(await store.head('member-alice')).toBe(0);
}
it('distinguishes an unrelated conflict from a changed subject', reportsUnchangedState);

async function reportsUnknownState(failure: 'timeout' | 'read error') {
  const cause = failure === 'timeout' ? new TimeoutError() : new Error('Recovery read failed');
  function failRead(): ReturnType<typeof store.readStream> {
    throw cause;
  }
  const reads = vi.spyOn(store, 'readStream').mockImplementationOnce(failRead);
  const publish = vi.spyOn(client, 'publish');
  const deadline = performance.now() + 2000;
  const command = { event: event('unknown'), expectedSequence: 0, deadline,
    historyChecked: true as const, checkAccess: saveUnrelated };
  expect(await store.appendOutcome(command)).toEqual({
    status: 'conditional_rejection_unknown', cause, mayHavePublished: false,
  });
  expect(performance.now()).toBeLessThan(deadline);
  expect(reads).toHaveBeenCalledExactlyOnceWith('member-alice', 1, deadline);
  expect(publish).toHaveBeenCalledTimes(1);
  reads.mockRestore();
  expect(await store.head('member-alice')).toBe(0);
}
it.each(['timeout', 'read error'] as const)(
  'reports unknown state after a definite rejection and %s', reportsUnknownState);

async function retainsEarlierUncertainty() {
  const publish = client.publish.bind(client);
  let publishes = 0;
  async function loseReplyThenReject(...parameters: Parameters<typeof publish>) {
    publishes += 1;
    if (publishes === 1) {
      await publish(...parameters);
      throw new TimeoutError();
    }
    // Use a different message id to reach NATS's real conditional rejection.
    const [subject, data, options] = parameters;
    return publish(subject, data, { ...options, msgID: 'retry-after-lost-reply' });
  }
  client.publish = loseReplyThenReject;
  const cause = new TimeoutError();
  function failRead(): ReturnType<typeof store.readStream> {
    throw cause;
  }
  vi.spyOn(store, 'readStream').mockImplementationOnce(failRead);
  const command = { event: event('lost'), expectedSequence: 0,
    historyChecked: true as const, deadline: performance.now() + 2000 };
  expect(await store.appendOutcome(command)).toEqual({
    status: 'conditional_rejection_unknown', cause, mayHavePublished: true,
  });
  expect(publishes).toBe(2);
  expect(await fixture.store.head('member-alice')).toBe(1);
}
it('keeps an earlier lost reply uncertain after a later rejection and read timeout',
  retainsEarlierUncertainty);

async function reportsTransportFailure(sent: boolean) {
  const cause = new TimeoutError();
  const controller = new AbortController();
  function loseTransport(): Promise<never> {
    controller.abort(cause);
    return Promise.reject(cause);
  }
  vi.spyOn(client, 'publish').mockImplementation(loseTransport);
  if (!sent) controller.abort(cause);
  const command = { event: event('transport'), expectedSequence: 0,
    historyChecked: true as const, signal: controller.signal };
  expect(await store.appendOutcome(command)).toEqual({
    status: 'transport_failure', cause, mayHavePublished: sent,
  });
  expect(await fixture.store.head()).toBe(0);
}
it.each([false, true])('reports transport failure with publication uncertainty %s',
  reportsTransportFailure);

async function reportsRejectedInput() {
  expect(await store.appendOutcome({ event: {}, expectedSequence: 0 }))
    .toEqual({ status: 'rejected', reason: 'invalid_event' });
  const original = event('same-id', 'member-bob');
  await fixture.store.append({ event: original, expectedSequence: 0 });
  const command = { event: event('same-id'), expectedSequence: 0, historyChecked: true as const };
  expect(await store.appendOutcome(command)).toEqual({ status: 'rejected', reason: 'duplicate_id' });
  expect(await store.head('member-alice')).toBe(0);
}
it('keeps input rejection separate from conditional and transport failures', reportsRejectedInput);
