import { expect, it, vi } from 'vitest';
import { parseEventByType } from '@opencrane/events';
import { event, natsFixture } from '@opencrane/event-store/testing';
import { history, seedOwnership } from '../src/index.ts';

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
      await expect(seedOwnership(nats.store, 'test')).rejects.toThrow('migration conflicted');
      expect(await nats.store.head('ownership-test')).toBe(0);
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
