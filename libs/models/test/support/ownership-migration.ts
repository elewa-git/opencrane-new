import { expect, vi } from 'vitest';
import type { EventStore } from '@opencrane/event-store';
import { event, type ManualClock } from '@opencrane/event-store/testing';
import { joinMembers, type TestMember } from '@opencrane/models/testing/members';

export function joinOwners(store: EventStore, ...memberIds: string[]) {
  function owner(memberId: string): TestMember {
    return { memberId, role: 'owner' };
  }
  const options = { store, silo: 'test' };
  const owners = memberIds.map(owner);
  return joinMembers(options, owners);
}

export function competeWithOwnershipSeed(store: EventStore, writeLimit: number) {
  const append = store.append.bind(store);
  let writes = 0;
  async function compete(command: Parameters<EventStore['append']>[0]) {
    if (writes < writeLimit) {
      writes++;
      const teamId = `competing-${writes}`;
      const data = { teamId, name: 'Competing write', createdBy: 'owner' };
      const record = { ...event(teamId, `team-${teamId}`, 'team.created'), data };
      const competingCommand = { event: record, expectedSequence: 0 };
      // Write after the scan so the seed's expected log position is out of date.
      const result = await append(competingCommand);
      expect(result.status).toBe('appended');
    }
    return append(command);
  }
  const spy = vi.spyOn(store, 'append');
  spy.mockImplementation(compete);
  return spy;
}

export function watchOwnershipWaits(clock: ManualClock) {
  const sleep = clock.sleep.bind(clock);
  let waiting = Promise.withResolvers<number>();
  function watch(milliseconds: number, signal?: AbortSignal) {
    if (!signal) {
      waiting.resolve(milliseconds);
    }
    return sleep(milliseconds, signal);
  }
  const spy = vi.spyOn(clock, 'sleep');
  spy.mockImplementation(watch);

  async function nextBefore(running: Promise<void>) {
    function finishedEarly(): never {
      throw new Error('Ownership migration finished before waiting again');
    }
    const wait = waiting.promise;
    const finished = running.then(finishedEarly);
    const milliseconds = await Promise.race([wait, finished]);
    waiting = Promise.withResolvers<number>();
    return milliseconds;
  }
  return { nextBefore, spy };
}
