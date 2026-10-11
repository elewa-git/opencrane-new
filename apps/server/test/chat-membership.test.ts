import type { EventStore, StoredEvent } from '@opencrane/event-store';
import { event } from '@opencrane/event-store/testing';
import { expect, it } from 'vitest';
import { chatMembership, ParticipationRefused } from '../src/chat/participation.ts';
import { ownConversation } from '../src/files/commands.ts';
import { FileRefusal } from '../src/files/refusals.ts';

function membershipStore(rows: StoredEvent[], failure?: Error) {
  async function* readStream(subject: string) {
    await Promise.resolve();
    if (!subject.startsWith('member-')) return;
    if (failure) throw failure;
    yield* rows;
  }
  const store = { readStream } satisfies Pick<EventStore, 'readStream'>;
  return store;
}

async function refusesInitialInactiveMembership() {
  const invited = { sequence: 1,
    event: event('invited', 'member-alice', 'member.invited') };
  const absent = membershipStore([]);
  const pending = membershipStore([invited]);
  expect(await chatMembership(absent, 'test', 'alice')).toBe(false);
  expect(await chatMembership(pending, 'test', 'alice')).toBe(false);
}
it('keeps absent and invited members inactive', refusesInitialInactiveMembership);

async function refusesAnotherMemberId() {
  const joined = { sequence: 1,
    event: event('joined', 'member-alice', 'member.joined') };
  joined.event.data.memberId = 'bob';
  const store = membershipStore([joined]);
  await expect(chatMembership(store, 'test', 'alice'))
    .rejects.toThrow('Membership history changed');
}
it('refuses a member id that differs from its subject', refusesAnotherMemberId);

async function translatesForeignMembership() {
  const joined = { sequence: 1,
    event: { ...event('joined', 'member-alice', 'member.joined'), silo: 'other' } };
  const store = membershipStore([joined]);
  const reading = chatMembership(store, 'test', 'alice');
  await expect(reading).rejects.toBeInstanceOf(ParticipationRefused);
  await expect(reading).rejects.toThrow('Active silo membership required');
}
it('refuses a foreign silo without revealing membership', translatesForeignMembership);

async function translatesMembershipRefusalForFiles() {
  const joined = { sequence: 1,
    event: { ...event('joined', 'member-alice', 'member.joined'), silo: 'other' } };
  const store = membershipStore([joined]);
  const reading = ownConversation(store, 'test', 'chat', 'alice');
  await expect(reading).rejects.toBeInstanceOf(FileRefusal);
  await expect(reading).rejects.toMatchObject({ kind: 'conversation_refused', statusCode: 403 });
}
it('translates a membership refusal into the file refusal', translatesMembershipRefusalForFiles);

async function preservesOtherMembershipErrors() {
  const unavailable = new Error('Member stream unavailable');
  const store = membershipStore([], unavailable);
  const reading = ownConversation(store, 'test', 'chat', 'alice');
  await expect(reading).rejects.toBe(unavailable);
}
it('preserves membership storage errors for file access', preservesOtherMembershipErrors);
