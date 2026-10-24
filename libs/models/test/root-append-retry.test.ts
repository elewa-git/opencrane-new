import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { JetStreamApiError, jetstream, jetstreamManager,
  type JetStreamClient } from '@nats-io/jetstream';
import { EventStore } from '@opencrane/event-store';
import { natsFixture } from '@opencrane/event-store/testing';
import { BudgetActor, envelope, history } from '../src/index.ts';
import { authorityFence } from '../src/authority.ts';

let nats: Awaited<ReturnType<typeof natsFixture>>;
let client: JetStreamClient;
let store: EventStore;
let actor: BudgetActor;
const binding = {
  requesterId: 'alice', conversationId: 'child', turnId: 'first-input',
  threadId: 'thread', assistantId: 'assistant', computerId: 'computer', generation: 1,
  payingGroupId: 'payer', allowanceCents: 1000,
};

async function setup() {
  nats = await natsFixture();
  client = jetstream(nats.connection);
  const manager = await jetstreamManager(nats.connection);
  store = new EventStore(client, manager);
  actor = new BudgetActor(store, 'test');
  await actor.start(10_000, 10_000, 'payer');
}

async function close() {
  vi.restoreAllMocks();
  await nats?.close();
}
beforeEach(setup);
afterEach(close);

function publishUnavailable() {
  const response = { code: 503, err_code: 10008, description: 'Publish unavailable' };
  return new JetStreamApiError(response);
}

async function saveSwitchOn() {
  const payload = {
    providerId: 'primary', revision: 1, changedBy: 'alice', expectedProviderSequence: 0,
  };
  const event = envelope('test', 'budget-test', 'provider.managed_calls_enabled', payload);
  const expectedSequence = await nats.store.head('budget-test');
  const command = { event, expectedSequence };
  expect((await nats.store.append(command)).status).toBe('appended');
}

async function refusesRevocationDuringRetry(switchOn: boolean) {
  const fresh = await authorityFence(store, performance.now(), ['member-alice']);
  if (switchOn) await saveSwitchOn();
  const before = await nats.store.head('budget-test');
  const publish = client.publish.bind(client);
  let failed = false;
  let conflictPending = switchOn;
  async function failOnce(...args: Parameters<typeof publish>) {
    if (conflictPending) {
      conflictPending = false;
      return publish(...args);
    }
    if (!failed) {
      failed = true;
      const payload = { memberId: 'alice', removedBy: 'owner' };
      const event = envelope('test', 'member-alice', 'member.removed', payload);
      const command = { event, expectedSequence: 0 };
      expect((await nats.store.append(command)).status).toBe('appended');
      throw publishUnavailable();
    }
    return publish(...args);
  }
  client.publish = failOnce;
  await expect(actor.setRootAllowance(binding, 1, fresh)).rejects.toThrow();
  expect(failed).toBe(true);
  expect(await nats.store.head('budget-test')).toBe(before);
  expect(actor.state.roots).toEqual([]);
  const rows = await history(nats.store, 'member-alice', 'test');
  expect(rows.at(-1)?.event.type).toBe('member.removed');
}
it.each([false, true])(
  'refuses a root after revocation during a failed publish (switch-on: %s)',
  refusesRevocationDuringRetry);

async function refusesRetryPastDeadline(switchOn: boolean) {
  const started = performance.now();
  const deadline = started + 2000;
  const clock = vi.spyOn(performance, 'now').mockReturnValue(started);
  if (switchOn) await saveSwitchOn();
  const before = await nats.store.head('budget-test');
  const publish = client.publish.bind(client);
  let failed = false;
  let conflictPending = switchOn;
  async function failOnce(...args: Parameters<typeof publish>) {
    if (conflictPending) {
      conflictPending = false;
      return publish(...args);
    }
    if (!failed) {
      failed = true;
      clock.mockReturnValue(deadline + 1);
      throw publishUnavailable();
    }
    return publish(...args);
  }
  client.publish = failOnce;
  try {
    await expect(actor.setRootAllowance(binding, 1, undefined, deadline)).rejects.toThrow();
  } finally {
    clock.mockRestore();
  }
  expect(failed).toBe(true);
  expect(await nats.store.head('budget-test')).toBe(before);
  expect(actor.state.roots).toEqual([]);
}
it.each([false, true])(
  'refuses a root when a failed publish passes the original deadline (switch-on: %s)',
  refusesRetryPastDeadline);

async function recoversWithinDeadline(switchOn: boolean) {
  const fresh = await authorityFence(store, performance.now(), ['member-alice']);
  if (switchOn) await saveSwitchOn();
  const before = await nats.store.head('budget-test');
  const publish = client.publish.bind(client);
  let failed = false;
  let conflictPending = switchOn;
  async function failOnce(...args: Parameters<typeof publish>) {
    if (conflictPending) {
      conflictPending = false;
      return publish(...args);
    }
    if (!failed) {
      failed = true;
      throw publishUnavailable();
    }
    return publish(...args);
  }
  client.publish = failOnce;
  const root = await actor.setRootAllowance(binding, 1, fresh, fresh.deadline);
  expect(failed).toBe(true);
  expect(root).toMatchObject(binding);
  expect(actor.state.roots).toEqual([root]);
  expect(await nats.store.head('budget-test')).toBe(before + 1);
  const rows = await history(nats.store, 'budget-test', 'test');
  expect(rows.at(-1)?.event.type).toBe('budget.root_allowance_set');
}
it.each([false, true])(
  'saves one root when transport recovers within valid access (switch-on: %s)',
  recoversWithinDeadline);
