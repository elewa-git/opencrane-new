import { expect, it } from 'vitest';
import { event, natsFixture } from '@opencrane/event-store/testing';
import type { EventEnvelope } from '@opencrane/events';
import { memberEventBeforeOwnershipSeed, ownerAtTransfer,
  supersededEvent } from '../src/backfill.ts';

function unapplied() {
  return Promise.resolve(false);
}

async function rejectsForeignSavedHistory(ownership: boolean) {
  const nats = await natsFixture();
  try {
    const joined = event('saved-role', 'member-alice', 'member.joined');
    const seed: EventEnvelope = event('saved-owners', 'ownership-test', 'ownership.seeded');
    seed.data = { ownerIds: ['alice'] };
    if (ownership) {
      seed.silo = 'other';
    } else {
      joined.silo = 'other';
    }
    await nats.seed([joined, seed]);
    const job = { ...joined, silo: 'test' };
    let message = 'does not match the saved role';
    if (ownership) {
      message = 'Ownership history silo mismatch';
    }
    await expect(memberEventBeforeOwnershipSeed(nats.store, job)).rejects.toThrow(message);
    await expect(supersededEvent(nats.store, job, unapplied)).rejects.toThrow('silo mismatch');
  } finally {
    await nats.close();
  }
}
it.each([false, true])('rejects saved history from another silo (ownership: %s)',
  rejectsForeignSavedHistory);

async function rejectsDifferentSavedRole() {
  const nats = await natsFixture();
  try {
    const saved: EventEnvelope = event('saved-role', 'member-alice', 'member.role_changed');
    const savedData = { memberId: 'alice', previousRole: 'member', newRole: 'admin',
      changedBy: 'bob' };
    saved.data = savedData;
    await nats.seed([saved]);
    const data = { ...savedData, newRole: 'owner' };
    const job = { ...saved, data };
    await expect(memberEventBeforeOwnershipSeed(nats.store, job))
      .rejects.toThrow('does not match the saved role');
    expect(await memberEventBeforeOwnershipSeed(nats.store, saved)).toBe(false);
    const seed: EventEnvelope = event('later-seed', 'ownership-test', 'ownership.seeded');
    seed.data = { ownerIds: ['alice'] };
    await nats.seed([seed]);
    expect(await memberEventBeforeOwnershipSeed(nats.store, saved)).toBe(true);
  } finally {
    await nats.close();
  }
}
it('refuses a role job that differs from its saved role', rejectsDifferentSavedRole);

async function rejectsDifferentSavedTransfer(field: string) {
  const nats = await natsFixture();
  try {
    const seed: EventEnvelope = event('transfer-seed', 'ownership-test', 'ownership.seeded');
    seed.data = { ownerIds: ['alice'] };
    const saved: EventEnvelope = event('saved-transfer', seed.subject, 'ownership.transferred');
    const savedData = { memberId: 'bob', transferredBy: 'alice' };
    saved.data = savedData;
    await nats.seed([seed, saved]);
    let job: EventEnvelope;
    if (field === 'missing') {
      job = { ...saved, id: 'missing-transfer' };
    } else if (field === 'silo') {
      job = { ...saved, silo: 'other' };
    } else {
      const data = { ...savedData, [field]: 'charlie' };
      job = { ...saved, data };
    }
    await expect(ownerAtTransfer(nats.store, job)).rejects.toThrow();
    expect(await ownerAtTransfer(nats.store, saved)).toBe(true);
  } finally {
    await nats.close();
  }
}
it.each(['memberId', 'transferredBy', 'missing', 'silo'])(
  'refuses a transfer with a different saved %s', rejectsDifferentSavedTransfer);
