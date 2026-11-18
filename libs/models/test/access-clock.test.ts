import { afterEach, expect, it, vi } from 'vitest';
import { manualClock, natsFixture, event } from '@opencrane/event-store/testing';
import { EventStore } from '@opencrane/event-store';
import { jetstream, jetstreamManager } from '@nats-io/jetstream';
import { authorityFence } from '../src/authority.ts';
import { payingGroupAuthority } from '../src/paying-group.ts';
import { BudgetActor } from '../src/actor.ts';
import { priceTableId } from '../src/state.ts';
import { accessDeadline } from '../src/budget-writer.ts';

let nats: Awaited<ReturnType<typeof natsFixture>> | undefined;
async function close() {
  vi.restoreAllMocks();
  await nats?.close();
  nats = undefined;
}
afterEach(close);

async function authorityDeadline(expired: boolean) {
  const clock = manualClock(performance.now() + 5000);
  function head() {
    return Promise.resolve(0);
  }
  async function* readStream() {}
  const store = { clock, head, readStream };
  const fresh = await authorityFence(store, clock.now(), ['member-alice']);
  if (expired) clock.advance(2001);
  if (expired) {
    await expect(fresh()).rejects.toThrow('Authority snapshot expired');
  } else {
    await expect(fresh()).resolves.toBeUndefined();
  }
}
it.each([false, true])('uses manual time for authority confirmation (expired: %s)',
  authorityDeadline);

async function payingAfterRead(expired: boolean, milliseconds: number) {
  const clock = manualClock(performance.now() + 5000);
  nats = await natsFixture({ clock });
  const joined = event('joined');
  const team = { ...event('team', 'team-sales', 'team.created'),
    data: { teamId: 'sales', name: 'Sales', createdBy: 'alice' } };
  const member = { ...event('team-member', 'team-sales', 'team.member_added'),
    data: { teamId: 'sales', memberId: 'alice', addedBy: 'alice' } };
  await nats.seed([joined, team, member]);
  const fresh = await payingGroupAuthority(nats.store, 'test', 'alice', 'sales');
  const head = nats.store.head.bind(nats.store);
  const teamHead = await head('team-sales');
  const memberHead = await head('member-alice');
  async function savedHead(subject?: string) {
    await Promise.resolve();
    if (subject === 'member-alice') clock.advance(milliseconds);
    if (subject === 'team-sales') return Promise.resolve(teamHead);
    return Promise.resolve(memberHead);
  }
  // Isolate the access check from the event store's own deadline refusal.
  vi.spyOn(nats.store, 'head').mockImplementation(savedHead);
  if (expired) {
    await expect(fresh()).rejects.toThrow('Paying group authority changed');
  } else {
    await expect(fresh()).resolves.toBeUndefined();
  }
}
function payingDeadline(expired: boolean) {
  return payingAfterRead(expired, expired ? 2001 : 0);
}
it.each([false, true])('uses manual time for group authority (expired: %s)', payingDeadline);

async function actorDeadline(expired: boolean) {
  const clock = manualClock(performance.now() + 5000);
  nats = await natsFixture({ clock });
  const actor = new BudgetActor(nats.store, 'test');
  await actor.start(100, 100, 'group');
  const call = { model: 'gpt-6-luna', priceTableId, computerId: 'computer',
    assistantId: 'assistant', requesterId: 'alice', conversationId: 'conversation',
    turnId: 'turn', threadId: 'thread', payingGroupId: 'group', contextDigest: '0'.repeat(64) };
  const reservation = await actor.reserve(call, 1);
  const sleep = vi.spyOn(clock, 'sleep');
  const releasing = actor.releaseUndispatched(reservation);
  if (expired) clock.advance(2001);
  if (expired) {
    await expect(releasing).rejects.toThrow('Budget append unavailable');
  } else {
    await releasing;
    expect(actor.state.reservations[0]?.settledCents).toBe(0);
  }
  expect(sleep).toHaveBeenCalledWith(2000, expect.any(AbortSignal));
}
it.each([false, true])('uses manual time for the actor queue (expired: %s)', actorDeadline);

async function fallbackDeadline(expired: boolean) {
  const clock = manualClock();
  const deadline = accessDeadline({ clock });
  expect(deadline).toBe(2000);
  if (expired) clock.advance(2001);
  nats = await natsFixture({ clock });
  const manager = await jetstreamManager(nats.connection);
  const store = new EventStore(jetstream(nats.connection), manager, manager, clock);
  const result = await store.append({ event: event('fallback'), expectedSequence: 0, deadline });
  if (expired) {
    expect(result.status).toBe('unavailable');
  } else {
    expect(result.status).toBe('appended');
  }
}
it.each([false, true])('uses manual time for fallback access limits (expired: %s)',
  fallbackDeadline);

async function authorityBoundary(milliseconds: number, duringRead: boolean) {
  const clock = manualClock(performance.now() + 5000);
  const reading = Promise.withResolvers<number>();
  const subjects: string[] = [];
  let confirmed = false;
  function head(subject?: string) {
    if (subject === undefined) return Promise.resolve(0);
    subjects.push(subject);
    if (!duringRead && milliseconds >= 2000) {
      throw new Error('Expired authority started a read');
    }
    return reading.promise;
  }
  async function* readStream() {
    yield await Promise.reject(new Error('Expired authority must not inspect changed history'));
  }
  const store = { clock, head, readStream };
  const fresh = await authorityFence(store, clock.now(), ['member-alice']);
  async function confirm() {
    await fresh();
    confirmed = true;
  }
  if (!duringRead) clock.advance(milliseconds);
  const result = confirm();
  if (duringRead) clock.advance(milliseconds);
  reading.resolve(0);
  if (milliseconds >= 2000) {
    await expect(result).rejects.toThrow('Authority snapshot expired');
    expect(confirmed).toBe(false);
  } else {
    await expect(result).resolves.toBeUndefined();
    expect(confirmed).toBe(true);
  }
  const startedRead = duringRead || milliseconds < 2000;
  expect(subjects).toEqual(startedRead ? ['member-alice'] : []);
}
it.each([1999, 2000])('checks authority before reads at %i ms', authorityBeforeRead);
it.each([1999, 2000])('checks authority after a pending head read at %i ms',
  authorityDuringRead);
function authorityBeforeRead(milliseconds: number) {
  return authorityBoundary(milliseconds, false);
}
function authorityDuringRead(milliseconds: number) {
  return authorityBoundary(milliseconds, true);
}

async function actorQueueBoundary(milliseconds: number) {
  const clock = manualClock(performance.now() + 5000);
  nats = await natsFixture({ clock });
  const actor = new BudgetActor(nats.store, 'test');
  await actor.start(100, 100, 'group');
  const previous = structuredClone(actor.state);
  const position = await nats.store.head('budget-test');
  separateStorageDeadline(nats.store);
  // Hold the caller's timer still so it cannot mask queue-entry refusal.
  const timerClock = manualClock();
  vi.spyOn(clock, 'sleep').mockImplementation(timerClock.sleep.bind(timerClock));
  const access = vi.fn(allowAccess);
  function allowAccess() {
    if (clock.now() >= started + 2000) {
      throw new Error('Expired actor started work');
    }
    return Promise.resolve();
  }
  const call = { model: 'gpt-6-luna', priceTableId, computerId: 'computer',
    assistantId: 'assistant', requesterId: 'alice', conversationId: 'conversation',
    turnId: 'turn', threadId: 'thread', payingGroupId: 'group', contextDigest: '0'.repeat(64) };
  const started = clock.now();
  const result = actor.reserve(call, 1, access);
  clock.advance(milliseconds);
  if (milliseconds >= 2000) {
    await expect(result).rejects.toThrow('Budget append unavailable');
    expect(access).not.toHaveBeenCalled();
    expect(actor.state).toEqual(previous);
    expect(await nats.store.head('budget-test')).toBe(position);
  } else {
    await expect(result).resolves.toEqual(expect.any(String));
    expect(access).toHaveBeenCalled();
    expect(actor.state.reservations).toHaveLength(1);
  }
}
it.each([1999, 2000])('checks actor queue entry at %i ms before work starts', actorQueueBoundary);

async function actorReadBoundary(milliseconds: number) {
  const clock = manualClock(performance.now() + 5000);
  nats = await natsFixture({ clock });
  const actor = new BudgetActor(nats.store, 'test');
  await actor.start(100, 100, 'group');
  const call = { model: 'gpt-6-luna', priceTableId, computerId: 'computer',
    assistantId: 'assistant', requesterId: 'alice', conversationId: 'conversation',
    turnId: 'turn', threadId: 'thread', payingGroupId: 'group', contextDigest: '0'.repeat(64) };
  const reservation = await actor.reserve(call, 1);
  const previous = structuredClone(actor.state);
  const position = await nats.store.head('budget-test');
  separateStorageDeadline(nats.store);
  const readStream = nats.store.readStream.bind(nats.store);
  let readCompleted = false;
  async function* timedRead(...args: Parameters<typeof readStream>) {
    yield* readStream(...args);
    if (!readCompleted) {
      clock.advance(milliseconds);
      readCompleted = true;
    }
  }
  vi.spyOn(nats.store, 'readStream').mockImplementation(timedRead);
  const result = actor.releaseUndispatched(reservation);
  if (milliseconds >= 2000) {
    await expect(result).rejects.toThrow('Budget append unavailable');
    expect(actor.state).toEqual(previous);
    expect(await nats.store.head('budget-test')).toBe(position);
  } else {
    await expect(result).resolves.toBeUndefined();
    expect(actor.state.reservations[0]?.settledCents).toBe(0);
  }
  expect(readCompleted).toBe(true);
}
it.each([1999, 2000])('checks actor expiry after an awaited read at %i ms', actorReadBoundary);

function payingBoundary(milliseconds: number) {
  return payingAfterRead(milliseconds >= 2000, milliseconds);
}
it.each([1999, 2000])('checks paying-group expiry after a head read at %i ms', payingBoundary);

function separateStorageDeadline(store: EventStore) {
  const append = store.append.bind(store);
  const readEvent = store.readEvent.bind(store);
  function appendWithStorageClock(command: Parameters<typeof append>[0]) {
    const storageCommand = { ...command };
    delete storageCommand.deadline;
    return append(storageCommand);
  }
  function readWithStorageClock(sequence: number) {
    return readEvent(sequence);
  }
  // Give real transport its own budget while the actor checks the exact manual boundary.
  vi.spyOn(store, 'append').mockImplementation(appendWithStorageClock);
  vi.spyOn(store, 'readEvent').mockImplementation(readWithStorageClock);
}
