import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { jetstream, jetstreamManager } from '@nats-io/jetstream';
import { TimeoutError } from '@nats-io/transport-node';
import { EventStore } from '../src/index.ts';
import { event, natsFixture } from './testing.ts';

let fixture: Awaited<ReturnType<typeof natsFixture>>;
let client: ReturnType<typeof jetstream>;
let store: EventStore;
async function setup() {
  fixture = await natsFixture();
  client = jetstream(fixture.connection);
  const manager = await jetstreamManager(fixture.connection);
  store = new EventStore(client, manager);
}
async function close() {
  vi.restoreAllMocks();
  await fixture.close();
}
beforeEach(setup);
afterEach(close);

async function outcomeRow(kind: string) {
  const saved = event('original');
  const command = { event: saved, expectedSequence: 0, historyChecked: true as const,
    deadline: performance.now() + 2000 };
  let injected = false;
  const publish = client.publish.bind(client);
  async function loseReply(...args: Parameters<typeof publish>) {
    await publish(...args);
    injected = true;
    command.deadline = performance.now();
    throw new TimeoutError();
  }
  async function unrelated() {
    const other = { event: event('other', 'member-bob'), expectedSequence: 0 };
    await fixture.store.append(other);
  }
  async function* failedRead(): AsyncGenerator<never> {
    injected = true;
    throw new TimeoutError();
  }
  if (kind === 'duplicate_saved' || kind === 'conditional_rejection_changed') {
    await store.append(command);
    if (kind === 'conditional_rejection_changed') command.event = event('new');
  }
  if (kind === 'conditional_rejection_unknown') {
    await unrelated();
    vi.spyOn(store, 'readStream').mockImplementation(failedRead);
  }
  if (kind === 'possibly published') client.publish = loseReply;
  if (kind === 'definitely unpublished') command.deadline = performance.now();
  let input = command;
  if (kind === 'conditional_rejection_unchanged' || kind === 'conditional_rejection_unknown') {
    input = Object.assign(command, { checkAccess: unrelated });
  }
  const result = await store.append(input);
  if (kind.includes('published')) {
    expect(result).toMatchObject({ status: 'unavailable',
      outcome: { kind: 'transport_failure', possiblyPublished: kind === 'possibly published' } });
  } else {
    expect(result).toMatchObject({ outcome: { kind } });
  }
  if (kind === 'duplicate_saved') {
    expect(result).toMatchObject({ outcome: { saved: { sequence: 1, event: saved } } });
  }
  if (kind === 'possibly published' || kind === 'conditional_rejection_unknown') {
    expect(injected).toBe(true);
  }
}
it.each(['appended', 'duplicate_saved', 'conditional_rejection_unchanged',
  'conditional_rejection_changed', 'conditional_rejection_unknown',
  'definitely unpublished', 'possibly published'])('reports evidence for %s', outcomeRow);

async function rejection(reason: 'invalid_event' | 'duplicate_id') {
  const first = event('collision');
  await store.append({ event: first, expectedSequence: 0 });
  let input: unknown = {};
  if (reason === 'duplicate_id') input = event('collision', 'member-bob');
  const result = await store.append({ event: input, expectedSequence: 0 });
  expect(result).toMatchObject({ status: 'rejected', reason,
    outcome: { kind: 'rejected', reason, possiblyPublished: false } });
  expect(await store.head()).toBe(1);
}
it.each(['invalid_event', 'duplicate_id'] as const)('reports %s without saving', rejection);
