import { expect, it } from 'vitest';
import { event, natsFixture } from './testing.ts';
import { parseEventByType } from '@opencrane/events';

function memberId(_unused: unknown, index: number) {
  return `member-${index}`;
}

async function validatesConversationWrites() {
  const nats = await natsFixture();
  try {
    const audience = Array.from({ length: 96 }, memberId);
    audience.push('ext:jane');
    const groupData = { conversationId: 'ext:chat', mode: 'group', createdBy: 'ext:jane',
      participantIds: audience, groupId: 'ext:team', groupSnapshotPosition: 1 };
    const created = { ...event('group', 'conversation-ext:chat', 'conversation.created'),
      data: groupData };
    const oversized = { ...created, data: { ...groupData,
      participantIds: audience.concat('extra') } };
    expect((await nats.store.append({ event: oversized, expectedSequence: 0 })).status)
      .toBe('rejected');
    expect(await nats.store.head()).toBe(0);
    expect((await nats.store.append({ event: created, expectedSequence: 0 })).status)
      .toBe('appended');
    const types = ['conversation.closed', 'participant.added', 'participant.removed'];
    for (const type of types) {
      let subject = 'participation-other';
      let data: unknown = { conversationId: 'ext:chat', participantId: 'ext:jane',
        addedBy: 'ext:jane' };
      if (type === 'participant.removed') {
        data = { conversationId: 'ext:chat', participantId: 'ext:jane', removedBy: 'ext:jane' };
      }
      if (type === 'conversation.closed') {
        subject = 'conversation-other';
        data = { conversationId: 'ext:chat', closedBy: 'ext:jane' };
      }
      const wrong = { ...event(type, subject, type), data };
      expect((await nats.store.append({ event: wrong, expectedSequence: 0 })).status)
        .toBe('rejected');
    }
    const wrongCreation = { ...created, id: 'wrong-creation', subject: 'conversation-other' };
    expect((await nats.store.append({ event: wrongCreation, expectedSequence: 0 })).status)
      .toBe('rejected');
    const added = { ...event('added', 'participation-ext:chat', 'participant.added'),
      data: { conversationId: 'ext:chat', participantId: 'ext:john', addedBy: 'ext:jane' } };
    expect((await nats.store.append({ event: added, expectedSequence: 0 })).status)
      .toBe('appended');
    const rows = await Array.fromAsync(nats.store.readStream('participation-ext:chat'));
    expect(rows[0]?.event.data).toEqual(added.data);
    const oldAudience = Array.from({ length: 99 }, memberId);
    oldAudience.push('alice');
    const oldGroup = { ...created, subject: 'conversation-old', data: {
      conversationId: 'old', mode: 'group', createdBy: 'alice', participantIds: oldAudience } };
    expect(parseEventByType(oldGroup).success).toBe(true);
    const oldParticipant = { ...added, subject: 'conversation-old', data: {
      conversationId: 'old', participantId: 'old.id', addedBy: 'old actor' } };
    expect(parseEventByType(oldParticipant).success).toBe(true);
    const invalidNewId = { ...oldParticipant, subject: 'participation-old' };
    expect((await nats.store.append({ event: invalidNewId, expectedSequence: 0 })).status)
      .toBe('rejected');
  } finally {
    await nats.close();
  }
}
it('refuses mismatched subjects and 98 people, accepts member ids and keeps old events parseable',
  validatesConversationWrites);

async function refusesWrongConversationIdentity() {
  const nats = await natsFixture();
  try {
    const samples = [
      { type: 'conversation.created', subject: 'conversation-wrong', data: {
        conversationId: 'chat', mode: 'group', createdBy: 'alice',
        participantIds: ['alice', 'bob'] } },
      { type: 'participant.added', subject: 'participation-wrong', data: {
        conversationId: 'chat', participantId: 'bob', addedBy: 'alice' } },
      { type: 'participant.removed', subject: 'participation-wrong-remove', data: {
        conversationId: 'chat', participantId: 'bob', removedBy: 'alice' } },
    ];
    for (const sample of samples) {
      const invalid = { ...event(sample.type, sample.subject, sample.type), data: sample.data };
      expect.soft((await nats.store.append({ event: invalid, expectedSequence: 0 })).status)
        .toBe('rejected');
    }
    expect(await nats.store.head()).toBe(0);
  } finally {
    await nats.close();
  }
}
it('rejects conversation and participation subjects that disagree with the recorded id',
  refusesWrongConversationIdentity);

async function validatesPrivatePreferences() {
  const nats = await natsFixture();
  try {
    const data = { conversationId: 'chat', memberId: 'alice', joinEventId: 'join', archived: true };
    const preference = { ...event('archive'), subject: 'chat-state-alice', type: 'conversation.archive_set',
      principal: { kind: 'human' as const, id: 'alice' }, data };
    const invalidEvents = [
      { ...preference, subject: 'chat-state-bob' },
      { ...preference, principal: { kind: 'human' as const, id: 'bob' } },
      { ...preference, principal: { kind: 'system' as const, id: 'alice' } },
      { ...preference, data: { ...data, text: 'private' } },
      { ...preference, silo: '' },
    ];
    for (const invalid of invalidEvents) {
      expect(parseEventByType(invalid).success).toBe(false);
      expect((await nats.store.append({ event: invalid, expectedSequence: 0 })).status)
        .toBe('rejected');
    }
    expect((await nats.store.append({ event: preference, expectedSequence: 0 })).status)
      .toBe('appended');
    const saved = await Array.fromAsync(nats.store.readStream('chat-state-alice'));
    expect(saved[0]?.event.data).toEqual(data);
  } finally {
    await nats.close();
  }
}
it('saves preferences only on the named person’s stream with their human identity',
  validatesPrivatePreferences);

async function closesOnSmallAccessStream() {
  const nats = await natsFixture();
  try {
    const data = { conversationId: 'chat', closedBy: 'alice' };
    const closed = { ...event('close', 'participation-chat', 'conversation.closed'), data };
    const command = { event: closed, expectedSequence: 0 };
    expect(await nats.store.append(command)).toMatchObject({ status: 'appended' });
    const old = { ...closed, id: 'old-close', commandId: 'old-close',
      subject: 'conversation-chat' };
    expect(parseEventByType(old).success).toBe(true);
    expect(await nats.store.append({ event: old, expectedSequence: 0 }))
      .toMatchObject({ status: 'rejected' });
    await nats.seed([old]);
    const rows = await Array.fromAsync(nats.store.readStream('conversation-chat'));
    expect(rows[0]?.event.type).toBe('conversation.closed');
  } finally {
    await nats.close();
  }
}
it('writes closes only to the small access stream and keeps old closes readable',
  closesOnSmallAccessStream);
