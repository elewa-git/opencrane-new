import { afterEach, expect, it } from 'vitest';
import { jetstream, jetstreamManager } from '@nats-io/jetstream';
import { TimeoutError } from '@nats-io/transport-node';
import type { EventEnvelope } from '@opencrane/events';
import { EventStore } from '../src/index.ts';
import { countReads, event, natsFixture } from './testing.ts';

let fixture: Awaited<ReturnType<typeof natsFixture>>;

async function close() {
  await fixture?.close();
}
afterEach(close);

async function storesWithoutReadingHistory() {
  fixture = await natsFixture();
  const events = [];
  for (let index = 0; index < 500; index++) {
    events.push(event(`history-${index}`));
  }
  await fixture.seed(events);
  const reads = countReads(fixture.store);
  const command = { event: event('new'), expectedSequence: 500, historyChecked: true as const };
  expect(await fixture.store.append(command)).toEqual({ status: 'appended', sequence: 501 });
  for (const call of reads.calls) {
    expect(call.fromSequence).toBeGreaterThan(500);
  }
  const stored = await Array.fromAsync(fixture.store.readStream('member-alice', 501));
  expect(stored).toMatchObject([{ sequence: 501, event: { id: 'new' } }]);
}

it('stores a new command on 500 events without reading history', storesWithoutReadingHistory);

async function searchesOnlyAfterExpectedSequence() {
  fixture = await natsFixture();
  const earlier = event('earlier');
  const copy = event('copy');
  await fixture.seed([earlier, copy, event('later')]);
  const reads = countReads(fixture.store);
  const command = {
    event: { ...copy, id: 'retry' }, expectedSequence: 1, historyChecked: true as const,
  };
  expect(await fixture.store.append(command)).toEqual({ status: 'appended', sequence: 2 });
  expect(reads.calls).toEqual([{ subject: 'member-alice', fromSequence: 2, rows: 1 }]);
  expect(await Array.fromAsync(fixture.store.readStream('member-alice'))).toHaveLength(3);
}
it('finds a lost acknowledgement after the expected position without storing twice',
  searchesOnlyAfterExpectedSequence);

async function refusesAnUnrelatedWrite() {
  fixture = await natsFixture();
  await fixture.seed([event('first'), event('other')]);
  const reads = countReads(fixture.store);
  const command = { event: event('new'), expectedSequence: 1, historyChecked: true as const };
  expect(await fixture.store.append(command)).toEqual({ status: 'conflict' });
  expect(reads.calls).toEqual([{ subject: 'member-alice', fromSequence: 2, rows: 1 }]);
  expect(await Array.fromAsync(fixture.store.readStream('member-alice'))).toHaveLength(2);
}
it('refuses a stale position with no copy and reads only the later events',
  refusesAnUnrelatedWrite);

async function storesRacingAttemptsOnce() {
  fixture = await natsFixture();
  const reads = countReads(fixture.store);
  const attempts = [];
  for (let index = 0; index < 8; index++) {
    const input = { ...event(`attempt-${index}`), commandId: 'one-command' };
    const command = { event: input, expectedSequence: 0, historyChecked: true as const };
    attempts.push(fixture.store.append(command));
  }
  const results = await Promise.all(attempts);
  for (const result of results) {
    expect(result).toEqual({ status: 'appended', sequence: 1 });
  }
  expect(reads.calls.length).toBeGreaterThanOrEqual(7);
  for (const call of reads.calls) {
    expect(call).toMatchObject({ subject: 'member-alice', fromSequence: 1 });
    expect(call.rows).toBeLessThanOrEqual(1);
  }
  expect(await Array.fromAsync(fixture.store.readStream('member-alice'))).toHaveLength(1);
}
it('returns one stored position to eight racing attempts with different event ids',
  storesRacingAttemptsOnce);

async function rejectsInvalidHistoryChecked(historyChecked: unknown) {
  fixture = await natsFixture();
  const command = { event: event('invalid'), expectedSequence: 0 };
  // Send a value that typed callers cannot supply, to check the runtime boundary.
  Reflect.set(command, 'historyChecked', historyChecked);
  const result = await fixture.store.append(command);
  expect(result).toEqual({ status: 'rejected', reason: 'invalid_event' });
  expect(await fixture.store.head()).toBe(0);
}
it.each([false, null, 1, 'true'])(
  'rejects historyChecked %s before storing anything', rejectsInvalidHistoryChecked);

async function retriesAfterLosingAPublishReply() {
  fixture = await natsFixture();
  await fixture.seed([event('earlier')]);
  const client = jetstream(fixture.connection);
  const manager = await jetstreamManager(fixture.connection);
  const store = new EventStore(client, manager);
  const publish = client.publish.bind(client);
  const attempts: Parameters<typeof publish>[2][] = [];
  let replies = 0;
  async function loseFirstReply(...args: Parameters<typeof publish>) {
    attempts.push(args[2]);
    const acknowledgement = await publish(...args);
    replies++;
    if (replies === 1) {
      throw new TimeoutError();
    }
    return acknowledgement;
  }
  client.publish = loseFirstReply;
  const reads = countReads(store);
  const command = { event: event('lost-reply'), expectedSequence: 1, historyChecked: true as const };
  expect(await store.append(command)).toEqual({ status: 'appended', sequence: 2 });
  // Accept either NATS order: a refusal then the short search, or a duplicate
  // acknowledgement checked by sameCommand.
  expect(replies).toBeGreaterThanOrEqual(1);
  expect(attempts.length).toBeGreaterThanOrEqual(2);
  for (const options of attempts) {
    expect(options).toMatchObject({
      msgID: 'lost-reply',
      expect: { streamName: 'EVENTS', lastSubjectSequence: 1 },
      retries: 1,
    });
  }
  for (const call of reads.calls) {
    expect(call).toMatchObject({ subject: 'member-alice', fromSequence: 2 });
    expect(call.rows).toBeLessThanOrEqual(1);
  }
  expect(await Array.fromAsync(store.readStream('member-alice'))).toHaveLength(2);
}
it('retries with the original position after NATS stores an event but its reply is lost',
  retriesAfterLosingAPublishReply);

async function findsCopiesWithOtherConditions(global: boolean) {
  fixture = await natsFixture();
  let copy: EventEnvelope = event('copy');
  if (global) {
    copy = { ...event('copy', 'ownership-test', 'ownership.seeded'),
      data: { ownerIds: ['alice'] } };
  }
  await fixture.seed([event('earlier', 'member-bob'), copy]);
  const reads = countReads(fixture.store);
  const condition = global ? { expectedGlobalSequence: 1 } : { expectedSubject: 'member-*' };
  const expectedSequence = global ? 0 : 1;
  const command = {
    ...condition, event: { ...copy, id: 'retry' }, expectedSequence,
    historyChecked: true as const,
  };
  expect(await fixture.store.append(command)).toEqual({ status: 'appended', sequence: 2 });
  for (const call of reads.calls) {
    expect(call).toMatchObject({ subject: copy.subject, fromSequence: expectedSequence + 1 });
    expect(call.rows).toBeLessThanOrEqual(1);
  }
  expect(await fixture.store.head()).toBe(2);
}
it.each([false, true])('finds a copy after a category or global refusal (global: %s)',
  findsCopiesWithOtherConditions);

async function refusesDuplicateIdOnAnotherSubject() {
  fixture = await natsFixture();
  await fixture.seed([event('same-id')]);
  const command = {
    event: event('same-id', 'member-bob'), expectedSequence: 0, historyChecked: true as const,
  };
  expect(await fixture.store.append(command)).toEqual({ status: 'rejected', reason: 'duplicate_id' });
  expect(await fixture.store.head()).toBe(1);
}
it('checks a duplicate acknowledgement against the command subject',
  refusesDuplicateIdOnAnotherSubject);

async function acceptsDuplicateAcknowledgementBeforeRefusal() {
  fixture = await natsFixture();
  const input = event('copy');
  const client = jetstream(fixture.connection);
  const manager = await jetstreamManager(fixture.connection);
  const store = new EventStore(client, manager);
  const options = {
    msgID: input.id, expect: { streamName: 'EVENTS', lastSubjectSequence: 0 },
  };
  const acknowledgement = await client.publish('ev.member.alice', JSON.stringify(input), options);
  function returnDuplicateReply() {
    const duplicate = { ...acknowledgement, duplicate: true };
    return Promise.resolve(duplicate);
  }
  // Exercise the other server ordering with the reply for a real stored event.
  client.publish = returnDuplicateReply;
  const command = { event: input, expectedSequence: 0, historyChecked: true as const };
  expect(await store.append(command)).toEqual({ status: 'appended', sequence: 1 });
  expect(await Array.fromAsync(store.readStream('member-alice'))).toHaveLength(1);
}
it('returns the stored copy when a duplicate acknowledgement arrives before a refusal',
  acceptsDuplicateAcknowledgementBeforeRefusal);

async function checksDuplicateAcknowledgement(change: string) {
  fixture = await natsFixture();
  const input = event('same-id');
  await fixture.seed([input]);
  if (change === 'commandId') {
    input.commandId = 'another-command';
  } else if (change === 'principal id') {
    input.principal.id = 'another-person';
  } else {
    input.principal.kind = 'system';
  }
  const command = { event: input, expectedSequence: 1, historyChecked: true as const };
  expect(await fixture.store.append(command)).toEqual({ status: 'rejected', reason: 'duplicate_id' });
  expect(await fixture.store.head()).toBe(1);
}
it.each(['commandId', 'principal id', 'principal kind'])(
  'checks %s on a duplicate acknowledgement', checksDuplicateAcknowledgement);

async function returnsFirstOfSeveralCopies() {
  fixture = await natsFixture();
  const first = event('first-copy');
  const second = { ...first, id: 'second-copy' };
  await fixture.seed([event('earlier'), first, second]);
  const reads = countReads(fixture.store);
  const command = {
    event: { ...first, id: 'retry' }, expectedSequence: 1, historyChecked: true as const,
  };
  expect(await fixture.store.append(command)).toEqual({ status: 'appended', sequence: 2 });
  for (const call of reads.calls) {
    expect(call).toMatchObject({ subject: first.subject, fromSequence: 2 });
    expect(call.rows).toBeLessThanOrEqual(1);
  }
  expect(await fixture.store.head()).toBe(3);
}
it('returns the first stored copy when seeded history contains several copies',
  returnsFirstOfSeveralCopies);
