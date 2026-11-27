import { expect, it, vi } from 'vitest';
import { parseEventByType } from '@opencrane/events';
import { event, manualClock, natsFixture } from '@opencrane/event-store/testing';
import { history, seedOwnership, ownershipSeedHandler } from '../src/index.ts';

async function fencesMigration() {
  const nats = await natsFixture();
  try {
    for (const memberId of ['alice', 'bob']) {
      const owner = { ...event(`join-${memberId}`, `member-${memberId}`, 'member.joined'),
        data: { memberId, email: `${memberId}@example.test`, displayName: memberId, role: 'owner' } };
      const command = { event: owner, expectedSequence: 0 };
      expect((await nats.store.append(command)).status).toBe('appended');
    }
    const original = nats.store.append.bind(nats.store);
    async function changeDuringMigration(command: Parameters<typeof original>[0]) {
      const parsed = parseEventByType(command.event);
      if (!parsed.success) {
        throw new Error('Invalid fixture event');
      }
      expect(parsed.event.type).toBe('ownership.seeded');
      const demotion = { ...event('demote-alice', 'member-alice', 'member.role_changed'),
        data: { memberId: 'alice', previousRole: 'owner', newRole: 'member', changedBy: 'bob' } };
      const expectedSequence = await nats.store.head('member-alice');
      await original({ event: demotion, expectedSequence });
      return original(command);
    }
    const spy = vi.spyOn(nats.store, 'append').mockImplementationOnce(changeDuringMigration);
    try {
      await seedOwnership(nats.store, 'test');
      const seeded = await history(nats.store, 'ownership-test', 'test');
      expect(seeded[0]?.event.data).toEqual({ ownerIds: ['bob'] });
    } finally {
      spy.mockRestore();
    }
    const migrations = [seedOwnership(nats.store, 'test'), seedOwnership(nats.store, 'test')];
    await Promise.all(migrations);
    await seedOwnership(nats.store, 'test');
    const rows = await history(nats.store, 'ownership-test', 'test');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.event.data).toEqual({ ownerIds: ['bob'] });
  } finally {
    await nats.close();
  }
}
it('migration fences concurrent member changes and competing seeds reconstruct only current owners',
  fencesMigration);

async function competeWithSeed(nats: Awaited<ReturnType<typeof natsFixture>>, writeLimit: number) {
  const owner = { ...event('join-owner', 'member-owner', 'member.joined'),
    data: { memberId: 'owner', email: 'owner@example.test', displayName: 'Owner', role: 'owner' } };
  const joined = await nats.store.append({ event: owner, expectedSequence: 0 });
  expect(joined.status).toBe('appended');
  const append = nats.store.append.bind(nats.store);
  let writes = 0;
  async function compete(command: Parameters<typeof append>[0]) {
    if (writes < writeLimit) {
      writes++;
      const teamId = `competing-${writes}`;
      const record = { ...event(teamId, `team-${teamId}`, 'team.created'),
        data: { teamId, name: 'Competing write', createdBy: 'owner' } };
      const result = await append({ event: record, expectedSequence: 0 });
      expect(result.status).toBe('appended');
    }
    return append(command);
  }
  return vi.spyOn(nats.store, 'append').mockImplementation(compete);
}

function clockForConflicts() {
  const clock = manualClock();
  function now() {
    return clock.now();
  }
  function sleep(milliseconds: number, signal?: AbortSignal) {
    // Let real NATS reads finish before their deadline timers.
    if (signal) {
      return clock.sleep(milliseconds, signal);
    }
    clock.advance(milliseconds);
    return Promise.resolve();
  }
  return { now, sleep };
}

async function seedsAfterCompetingWrites() {
  const clock = clockForConflicts();
  const nats = await natsFixture({ clock });
  try {
    const spy = await competeWithSeed(nats, 5);
    try {
      await seedOwnership(nats.store, 'test');
      expect(clock.now()).toBeGreaterThan(0);
    } finally {
      spy.mockRestore();
    }
    await seedOwnership(nats.store, 'test');
    const rows = await history(nats.store, 'ownership-test', 'test');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.event.data).toEqual({ ownerIds: ['owner'] });
  } finally {
    await nats.close();
  }
}
it('waits and saves ownership once after five competing writes', seedsAfterCompetingWrites);

async function boundsSeedConflicts() {
  const clock = clockForConflicts();
  const nats = await natsFixture({ clock });
  try {
    await competeWithSeed(nats, Infinity);
    await expect(seedOwnership(nats.store, 'test'))
      .rejects.toThrow('Timed out waiting for ownership migration conflicts to settle');
    expect(await nats.store.head('ownership-test')).toBe(0);
  } finally {
    await nats.close();
  }
}
it('stops without saving ownership when competing writes keep coming', boundsSeedConflicts);

async function oldBootstrapDoesNotRestoreOwnership() {
  const nats = await natsFixture();
  try {
    const owner = event('old-bootstrap', 'member-bootstrap-owner', 'silo.owner_bootstrapped');
    const removed = event('removed-bootstrap', owner.subject, 'member.removed');
    await nats.seed([owner, removed]);
    const noSql = { query: () => Promise.reject(new Error('Unexpected SQL')) };
    await ownershipSeedHandler(nats.store).handle(owner, noSql);
    expect(await history(nats.store, 'ownership-test', 'test')).toEqual([]);
  } finally {
    await nats.close();
  }
}
it('checks current owners before handling an old bootstrap event', oldBootstrapDoesNotRestoreOwnership);
