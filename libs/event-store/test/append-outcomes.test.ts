import { getEventDefinition } from '@opencrane/events';
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

async function outcomeRow([kind, repeated]: [string, boolean]) {
  const saved = event('original');
  const command = { event: saved, expectedSequence: 0, historyChecked: true as const,
    deadline: performance.now() + 2000 };
  let injected = false;
  const publish = client.publish.bind(client);
  async function loseReply(...args: Parameters<typeof publish>): Promise<never> {
    await publish(...args);
    injected = true;
    vi.spyOn(performance, 'now').mockReturnValue(command.deadline);
    throw new TimeoutError();
  }
  let unrelatedCount = 0;
  async function unrelated() {
    unrelatedCount += 1;
    const id = `other-${unrelatedCount}`;
    const other = { event: event(id, `member-${id}`), expectedSequence: 0 };
    await fixture.store.append(other);
  }
  async function* failedRead(): AsyncGenerator<never> {
    injected = true;
    yield await Promise.reject(new TimeoutError());
  }
  if (repeated) {
    const refused = await store.append({ ...command, checkAccess: unrelated });
    expect(refused).toMatchObject({ status: 'conflict' });
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
    expect(result).toMatchObject({ outcome: { saved: { event: saved } } });
  }
  if (kind === 'possibly published' || kind === 'conditional_rejection_unknown') {
    expect(injected).toBe(true);
  }
}
const scenarios: [string, boolean][] = [];
for (const kind of ['appended', 'duplicate_saved', 'conditional_rejection_unchanged',
  'conditional_rejection_changed', 'conditional_rejection_unknown',
  'definitely unpublished', 'possibly published']) {
  scenarios.push([kind, false], [kind, true]);
}
function scenario(kind: string, repeated: boolean) {
  return outcomeRow([kind, repeated]);
}
it.each(scenarios)('reports evidence for %s (after conflict: %s)', scenario);

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

async function retainsEarlierUncertainty() {
  const publish = client.publish.bind(client);
  let attempts = 0;
  async function delayedThenRejected(...args: Parameters<typeof publish>) {
    attempts += 1;
    if (attempts === 1) throw new TimeoutError();
    return publish(...args);
  }
  client.publish = delayedThenRejected;
  const definition = getEventDefinition('conversation.child_result_published')!;
  const saved = { ...event('uncertain', 'conversation-parent', definition.type),
    data: definition.example };
  const other = { event: event('unrelated', 'member-other'), expectedSequence: 0 };
  await fixture.store.append(other);
  const result = await store.append({ event: saved, expectedSequence: 0,
    expectedGlobalSequence: 0, historyChecked: true, deadline: performance.now() + 2000 });
  expect(attempts).toBe(2);
  expect(result).toMatchObject({ status: 'unavailable',
    outcome: { kind: 'conditional_rejection_unchanged', possiblyPublished: true } });
  expect(await store.head(saved.subject)).toBe(0);
}
it('retains a lost attempt after a later definite rejection and empty read', retainsEarlierUncertainty);

async function failedDuplicateRead() {
  const saved = event('saved');
  await store.append({ event: saved, expectedSequence: 0 });
  const cause = new Error('Readback failed');
  const reading = vi.spyOn(store, 'readEvent').mockRejectedValue(cause);
  const result = await store.append({ event: saved, expectedSequence: 1, historyChecked: true });
  expect(reading).toHaveBeenCalled();
  expect(result).toMatchObject({ status: 'unavailable',
    outcome: { kind: 'transport_failure', possiblyPublished: true } });
  expect(await store.head()).toBe(1);
}
it('keeps failed duplicate readback uncertain instead of reporting a collision', failedDuplicateRead);

async function privateEvidence() {
  const saved = event('private-receipt');
  const command = { event: saved, expectedSequence: 0 };
  await store.append(command);
  const result = await store.append(command);
  expect(result.outcome).toMatchObject({ kind: 'duplicate_saved', saved: { event: saved } });
  expect(JSON.parse(JSON.stringify(result))).toEqual({ status: 'appended', sequence: 1 });
}
it('keeps saved recovery history out of serialised receipts', privateEvidence);

async function foreignSiloDuplicate() {
  const saved = event('silo-collision');
  await store.append({ event: saved, expectedSequence: 0 });
  const foreign = { ...saved, silo: 'other' };
  const result = await store.append({ event: foreign, expectedSequence: 1, historyChecked: true });
  expect(result).toMatchObject({ status: 'rejected', reason: 'duplicate_id' });
  expect(await store.head()).toBe(1);
}
it('refuses a duplicate from another silo with the same command and principal', foreignSiloDuplicate);
