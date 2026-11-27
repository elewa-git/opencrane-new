import { expect, it, vi } from 'vitest';
import type { AppendResult, EventStore } from '@opencrane/event-store';
import { event, manualClock, natsFixture } from '@opencrane/event-store/testing';
import { history, seedDevelopmentOwnership, ownershipSeedHandler } from '../src/index.ts';
import { competeWithOwnershipSeed, joinOwners, watchOwnershipWaits } from './support/ownership-migration.ts';

const silo = 'test';
const ownership = 'ownership-test';
const members = 'member-*';

async function rescansAfterDemotion() {
  const clock = manualClock();
  const options = { clock };
  const nats = await natsFixture(options);
  try {
    await joinOwners(nats.store, 'alice', 'bob');
    const append = nats.store.append.bind(nats.store);
    async function demoteBeforeSaving(command: Parameters<EventStore['append']>[0]) {
      const data = { memberId: 'alice', previousRole: 'owner', newRole: 'member', changedBy: 'bob' };
      const demotion = { ...event('demote-alice', 'member-alice', 'member.role_changed'), data };
      const expectedSequence = await nats.store.head(demotion.subject);
      const demotionCommand = { event: demotion, expectedSequence };
      expect((await append(demotionCommand)).status).toBe('appended');
      return append(command);
    }
    const spy = vi.spyOn(nats.store, 'append');
    spy.mockImplementationOnce(demoteBeforeSaving);
    const waits = watchOwnershipWaits(clock);
    const running = seedDevelopmentOwnership(nats.store, silo);
    expect(await waits.nextBefore(running)).toBe(100);
    clock.advance(100);
    await running;
    const rows = await history(nats.store, ownership, silo);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.event.data).toEqual({ ownerIds: ['bob'] });
  } finally {
    await nats.close();
  }
}
it('reads the owners again after a concurrent demotion', rescansAfterDemotion);

async function racesOnEmptyOwnership() {
  const nats = await natsFixture();
  try {
    await joinOwners(nats.store, 'alice');
    const append = nats.store.append.bind(nats.store);
    const bothReady = Promise.withResolvers<void>();
    let attempts = 0;
    async function reachEmptyStreamTogether(command: Parameters<EventStore['append']>[0]) {
      expect(command.expectedSequence).toBe(0);
      attempts++;
      if (attempts === 2) {
        bothReady.resolve();
      }
      await bothReady.promise;
      return append(command);
    }
    const spy = vi.spyOn(nats.store, 'append');
    spy.mockImplementation(reachEmptyStreamTogether);
    const first = seedDevelopmentOwnership(nats.store, silo);
    const second = seedDevelopmentOwnership(nats.store, silo);
    await Promise.all([first, second]);
    expect(spy).toHaveBeenCalledTimes(2);
    const rows = await history(nats.store, ownership, silo);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.event.data).toEqual({ ownerIds: ['alice'] });
  } finally {
    await nats.close();
  }
}
it('lets two migrations start from an empty stream and save one owner list', racesOnEmptyOwnership);

async function waitsBeforeReadingAgain() {
  const clock = manualClock();
  const options = { clock };
  const nats = await natsFixture(options);
  try {
    await joinOwners(nats.store, 'owner');
    const appends = competeWithOwnershipSeed(nats.store, 5);
    const heads = vi.spyOn(nats.store, 'head');
    const reads = vi.spyOn(nats.store, 'readStream');
    const waits = watchOwnershipWaits(clock);
    const running = seedDevelopmentOwnership(nats.store, silo);
    for (let attempt = 1; attempt <= 5; attempt++) {
      expect(await waits.nextBefore(running)).toBe(100);
      expect(heads).toHaveBeenCalledTimes(attempt);
      expect(reads.mock.calls.filter(isMemberScan)).toHaveLength(attempt);
      expect(appends).toHaveBeenCalledTimes(attempt);
      clock.advance(99);
      await Promise.resolve();
      expect(heads).toHaveBeenCalledTimes(attempt);
      expect(reads.mock.calls.filter(isMemberScan)).toHaveLength(attempt);
      clock.advance(1);
    }
    await running;
    expect(appends).toHaveBeenCalledTimes(6);
    const rows = await history(nats.store, ownership, silo);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.event.data).toEqual({ ownerIds: ['owner'] });
    await seedDevelopmentOwnership(nats.store, silo);
    expect(appends).toHaveBeenCalledTimes(6);
  } finally {
    await nats.close();
  }
}
function isMemberScan([subject]: Parameters<EventStore['readStream']>) {
  return subject === members;
}
it('holds each wait open and saves ownership on the first call after five real writes',
  waitsBeforeReadingAgain);

async function usesOnlyTheRemainingTime() {
  const clock = manualClock();
  const options = { clock };
  const nats = await natsFixture(options);
  try {
    await joinOwners(nats.store, 'alice');
    const conflict = { status: 'conflict' } satisfies AppendResult;
    function conflictNearDeadline() {
      clock.advance(9_975);
      return Promise.resolve(conflict);
    }
    const appends = vi.spyOn(nats.store, 'append');
    appends.mockImplementationOnce(conflictNearDeadline);
    const waits = watchOwnershipWaits(clock);
    const running = seedDevelopmentOwnership(nats.store, silo);
    expect(await waits.nextBefore(running)).toBe(25);
    clock.advance(24);
    await Promise.resolve();
    expect(appends).toHaveBeenCalledTimes(1);
    clock.advance(1);
    await expect(running).rejects.toThrow('Timed out waiting for ownership migration conflicts to settle');
    expect(clock.now()).toBe(10_000);
    expect(appends).toHaveBeenCalledTimes(1);
    expect(await nats.store.head(ownership)).toBe(0);
  } finally {
    await nats.close();
  }
}
it('waits only the last 25 ms and stops at ten seconds', usesOnlyTheRemainingTime);

async function doesNotWaitAfterExpiry() {
  const clock = manualClock();
  const options = { clock };
  const nats = await natsFixture(options);
  try {
    await joinOwners(nats.store, 'alice');
    const conflict = { status: 'conflict' } satisfies AppendResult;
    function conflictAtDeadline() {
      clock.advance(10_000);
      return Promise.resolve(conflict);
    }
    const appends = vi.spyOn(nats.store, 'append');
    appends.mockImplementationOnce(conflictAtDeadline);
    const waits = watchOwnershipWaits(clock);
    await expect(seedDevelopmentOwnership(nats.store, silo))
      .rejects.toThrow('Timed out waiting for ownership migration conflicts to settle');
    const pauses = waits.spy.mock.calls.filter(isRetryWait);
    expect(pauses).toEqual([]);
    expect(appends).toHaveBeenCalledTimes(1);
    expect(await nats.store.head(ownership)).toBe(0);
  } finally {
    await nats.close();
  }
}
function isRetryWait([, signal]: Parameters<EventStore['clock']['sleep']>) {
  return signal === undefined;
}
it('does not start another wait when the last conflict uses the full budget', doesNotWaitAfterExpiry);

const slowReads = ['log position', 'ownership history', 'member history'] as const;
type SlowRead = (typeof slowReads)[number];

async function stopsAtSlowRead(slowRead: SlowRead) {
  const clock = manualClock();
  const options = { clock };
  const nats = await natsFixture(options);
  try {
    await joinOwners(nats.store, 'alice');
    const head = nats.store.head.bind(nats.store);
    const read = nats.store.readStream.bind(nats.store);
    function slowHead(...args: Parameters<EventStore['head']>) {
      if (slowRead === 'log position') {
        clock.advance(10_000);
      }
      return head(...args);
    }
    async function* slowHistory(...args: Parameters<EventStore['readStream']>) {
      const [subject] = args;
      if ((slowRead === 'ownership history' && subject === ownership)
        || (slowRead === 'member history' && subject === members)) {
        clock.advance(10_000);
      }
      yield* read(...args);
    }
    const heads = vi.spyOn(nats.store, 'head');
    heads.mockImplementation(slowHead);
    const reads = vi.spyOn(nats.store, 'readStream');
    reads.mockImplementation(slowHistory);
    const appends = vi.spyOn(nats.store, 'append');
    await expect(seedDevelopmentOwnership(nats.store, silo)).rejects.toMatchObject({
      name: 'TimeoutError',
    });
    expect(heads).toHaveBeenCalledWith(undefined, 10_000);
    const expectedReads = {
      'log position': [],
      'ownership history': [[ownership, 1, 10_000]],
      'member history': [[ownership, 1, 10_000], [members, 1, 10_000]],
    };
    expect(reads.mock.calls).toEqual(expectedReads[slowRead]);
    expect(appends).not.toHaveBeenCalled();
    expect(await head(ownership)).toBe(0);
  } finally {
    await nats.close();
  }
}
it.each(slowReads)('uses the same deadline for the %s read', stopsAtSlowRead);

async function refusesLateAppend() {
  const clock = manualClock();
  const options = { clock };
  const nats = await natsFixture(options);
  try {
    await joinOwners(nats.store, 'alice');
    const append = nats.store.append.bind(nats.store);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    async function slowAppend(command: Parameters<EventStore['append']>[0]) {
      clock.advance(9_975);
      entered.resolve();
      await release.promise;
      return append(command);
    }
    const appends = vi.spyOn(nats.store, 'append');
    appends.mockImplementationOnce(slowAppend);
    const running = seedDevelopmentOwnership(nats.store, silo);
    await entered.promise;
    expect(await nats.store.head(ownership)).toBe(0);
    clock.advance(25);
    release.resolve();
    await expect(running).rejects.toThrow('Ownership migration unavailable');
    expect(appends).toHaveBeenCalledTimes(1);
    expect(await nats.store.head(ownership)).toBe(0);
  } finally {
    await nats.close();
  }
}
it('refuses to save when the final append cannot start before expiry', refusesLateAppend);

async function leavesTheSavedSeedAlone() {
  const nats = await natsFixture();
  try {
    await joinOwners(nats.store, 'alice');
    await seedDevelopmentOwnership(nats.store, silo);
    await joinOwners(nats.store, 'bob');
    const reads = vi.spyOn(nats.store, 'readStream');
    const appends = vi.spyOn(nats.store, 'append');
    await seedDevelopmentOwnership(nats.store, silo);
    expect(reads.mock.calls.map(readSubject)).toEqual([ownership]);
    expect(appends).not.toHaveBeenCalled();
    const rows = await history(nats.store, ownership, silo);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.event.data).toEqual({ ownerIds: ['alice'] });
  } finally {
    await nats.close();
  }
}
function readSubject([subject]: Parameters<EventStore['readStream']>) {
  return subject;
}
it('keeps the saved owner list after a later member joins', leavesTheSavedSeedAlone);

async function ignoresMembersBeyondTheCapturedPosition() {
  const clock = manualClock();
  const options = { clock };
  const nats = await natsFixture(options);
  try {
    await joinOwners(nats.store, 'alice');
    const read = nats.store.readStream.bind(nats.store);
    const reads = vi.spyOn(nats.store, 'readStream');
    let joined = false;
    async function* withLateMember(...args: Parameters<EventStore['readStream']>) {
      if (args[0] === members && !joined) {
        joined = true;
        await joinOwners(nats.store, 'bob');
      }
      yield* read(...args);
    }
    reads.mockImplementation(withLateMember);
    const appends = vi.spyOn(nats.store, 'append');
    const waits = watchOwnershipWaits(clock);
    const running = seedDevelopmentOwnership(nats.store, silo);
    expect(await waits.nextBefore(running)).toBe(100);
    const firstSeed = appends.mock.calls.at(-1)?.[0];
    expect(firstSeed?.event).toMatchObject({
      type: 'ownership.seeded', data: { ownerIds: ['alice'] },
    });
    clock.advance(100);
    await running;
    const rows = await history(nats.store, ownership, silo);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.event.data).toEqual({ ownerIds: ['alice', 'bob'] });
  } finally {
    await nats.close();
  }
}
it('leaves a late member out of the first scan and includes them on the next',
  ignoresMembersBeyondTheCapturedPosition);

const mismatches = [
  [{ silo: 'elsewhere' }, 'Migration silo mismatch'],
  [{ subject: 'member-bob' }, 'Member subject mismatch'],
] as const;

async function refusesMismatchedHistory(replacement: { silo?: string; subject?: string },
  message: string) {
  const nats = await natsFixture();
  try {
    await joinOwners(nats.store, 'alice');
    const read = nats.store.readStream.bind(nats.store);
    async function* corruptMember(...args: Parameters<EventStore['readStream']>) {
      for await (const row of read(...args)) {
        if (args[0] === members) {
          yield { ...row, event: { ...row.event, ...replacement } };
        } else {
          yield row;
        }
      }
    }
    const reads = vi.spyOn(nats.store, 'readStream');
    reads.mockImplementation(corruptMember);
    const appends = vi.spyOn(nats.store, 'append');
    await expect(seedDevelopmentOwnership(nats.store, silo)).rejects.toThrow(message);
    expect(appends).not.toHaveBeenCalled();
    expect(await nats.store.head(ownership)).toBe(0);
  } finally {
    await nats.close();
  }
}
it.each(mismatches)('refuses mismatched member history %j', refusesMismatchedHistory);

const eventStoreError = new Error('Event store unavailable');
const appendErrors = [
  [{ status: 'unavailable', cause: eventStoreError }, 'Ownership migration unavailable',
    eventStoreError],
  [{ status: 'rejected', reason: 'invalid_event' }, 'Ownership migration rejected', 'invalid_event'],
] as const;

async function reportsAppendError(result: AppendResult, message: string, cause: unknown) {
  const clock = manualClock();
  const options = { clock };
  const nats = await natsFixture(options);
  try {
    await joinOwners(nats.store, 'alice');
    const appends = vi.spyOn(nats.store, 'append');
    appends.mockResolvedValue(result);
    const sleep = clock.sleep.bind(clock);
    function refuseRetry(milliseconds: number, signal?: AbortSignal) {
      if (!signal) {
        throw new Error('Ownership migration tried again after an append failure');
      }
      return sleep(milliseconds, signal);
    }
    const waits = vi.spyOn(clock, 'sleep');
    waits.mockImplementation(refuseRetry);
    const expectedError = { message, cause };
    await expect(seedDevelopmentOwnership(nats.store, silo)).rejects.toMatchObject(expectedError);
    expect(appends).toHaveBeenCalledTimes(1);
    expect(await nats.store.head(ownership)).toBe(0);
  } finally {
    await nats.close();
  }
}
it.each(appendErrors)('returns the append failure and cause immediately (%j)', reportsAppendError);

function unexpectedQuery(): never {
  throw new Error('Unexpected SQL');
}
const noSql = { query: unexpectedQuery };

async function stopsAfterFiveClaimAttempts() {
  const nats = await natsFixture();
  try {
    const owner = event('owner-claim', 'member-bootstrap-owner', 'silo.owner_bootstrapped');
    const events = [owner];
    await nats.seed(events);
    const appends = competeWithOwnershipSeed(nats.store, 5);
    const handler = ownershipSeedHandler(nats.store);
    await expect(handler.handle(owner, noSql))
      .rejects.toThrow('Ownership migration conflicted after five attempts');
    expect(appends).toHaveBeenCalledTimes(5);
    expect(await nats.store.head(ownership)).toBe(0);
  } finally {
    await nats.close();
  }
}
it('stops one token claim delivery after five conflicts', stopsAfterFiveClaimAttempts);

async function oldBootstrapDoesNotRestoreOwnership() {
  const nats = await natsFixture();
  try {
    const owner = event('old-bootstrap', 'member-bootstrap-owner', 'silo.owner_bootstrapped');
    const removed = event('removed-bootstrap', owner.subject, 'member.removed');
    const events = [owner, removed];
    await nats.seed(events);
    const handler = ownershipSeedHandler(nats.store);
    await handler.handle(owner, noSql);
    expect(await history(nats.store, ownership, silo)).toEqual([]);
  } finally {
    await nats.close();
  }
}
it('checks current owners before handling an old bootstrap event', oldBootstrapDoesNotRestoreOwnership);
