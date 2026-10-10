import { expect, it, vi } from 'vitest';
import { createStore, memberAuthorisation } from '@opencrane/authz';
import { databases, openfga } from '@opencrane/authz/testing';
import { event, natsFixture } from '@opencrane/event-store/testing';
import { history } from '@opencrane/models';
import { pgDb, readEvents } from '@opencrane/projections';
import { roleCommand } from '../src/members/roles.ts';
import { turnCommand } from '../src/chat/turns.ts';

async function fixture() {
  const nats = await natsFixture();
  const fga = await openfga();
  const dbs = await databases();
  const binding = await createStore(fga.apiUrl, 'test');
  const auth = memberAuthorisation(binding);
  const db = pgDb(dbs.queue);
  let count = 0;
  async function append(subject: string, type: string, data: unknown) {
    const record = { ...event(`access-${++count}`, subject, type), data };
    const expectedSequence = await nats.store.head(subject);
    const command = { event: record, expectedSequence };
    expect((await nats.store.append(command)).status).toBe('appended');
    return record;
  }
  for (const [memberId, role] of [
    ['alice', 'owner'], ['bob', 'member'], ['charlie', 'member'], ['david', 'member'],
  ]) {
    await append(`member-${memberId}`, 'member.joined', {
      memberId, role, displayName: memberId, email: `${memberId}@example.test`,
    });
  }
  await append('ownership-test', 'ownership.seeded', { ownerIds: ['alice'] });
  for (const memberId of ['bob', 'charlie']) {
    const request = await append('ownership-test', 'ownership.transferred', {
      memberId, transferredBy: 'alice', awaitingConfirmation: true,
    });
    await append(`member-${memberId}`, 'member.ownership_confirmed', {
      memberId, appointmentId: request.id,
    });
    await append('ownership-test', 'ownership.stepped_down', { memberId });
  }
  await append('team-group', 'team.created', {
    teamId: 'group', name: 'Group', createdBy: 'alice',
  });
  await append('team-group', 'team.member_added', {
    teamId: 'group', memberId: 'charlie', addedBy: 'alice',
  });
  await append('assistant-assistant', 'assistant.created', {
    assistantId: 'assistant', ownerId: 'group', kind: 'team', payingGroupId: 'group',
  });
  await append('conversation-chat', 'conversation.created', {
    conversationId: 'chat', createdBy: 'charlie', mode: 'agent_session',
    assistantId: 'assistant', payingGroupId: 'group',
  });
  await append('conversation-chat', 'message.posted', {
    conversationId: 'chat', authorId: 'charlie', authorKind: 'human', contentType: 'text',
    ciphertext: Buffer.from('Encrypted fixture message').toString('base64'), keyId: 'key:test',
  });
  await append('computer-assistant', 'computer.ready', {
    assistantId: 'assistant', computerId: 'computer', generation: 1,
  });
  for await (const row of readEvents(nats.reader, 1, await nats.reader.head())) {
    if (auth.handler.eventTypes.includes(row.event.type)) {
      await auth.handler.handle(row.event, db);
    }
  }
  async function close() {
    vi.restoreAllMocks();
    await dbs.close();
    await fga.close();
    await nats.close();
  }
  return { nats, binding, db, append, close };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
type Operation = 'role' | 'turn';
async function runOperation(context: Fixture, operation: Operation) {
  if (operation === 'role') {
    const input = { commandId: 'change-david', newRole: 'admin',
      expectedSequence: await context.nats.store.head('member-david') };
    function unusedMemberId() {
      return Promise.resolve(undefined);
    }
    const options = { silo: 'test', store: context.nats.store, binding: context.binding,
      db: context.db, feed: { memberId: unusedMemberId } };
    expect(await roleCommand(options, 'charlie', 'david', input))
      .toMatchObject({ status: 'recorded' });
    return;
  }
  const turnContext = { silo: 'test', store: context.nats.store,
    binding: context.binding, assistantId: 'assistant', computerId: 'computer' };
  const input = { conversationId: 'chat', turnId: 'access-15', threadId: 'thread',
    status: 'started' as const, executionMode: 'restricted' as const };
  const messages = await history(context.nats.store, 'conversation-chat', 'test');
  input.turnId = messages.at(-1)!.event.id;
  expect(await turnCommand(context.nats.store, turnContext, input))
    .toMatchObject({ requesterId: 'charlie', payingGroupId: 'group' });
}

async function unrelatedFormerSuccessor(operation: Operation) {
  const context = await fixture();
  const originalHead = context.nats.store.head.bind(context.nats.store);
  let changed = false;
  async function changeFormerSuccessor(subject?: string, deadline?: number) {
    if (subject === 'member-charlie' && !changed) {
      changed = true;
      await context.append('member-bob', 'member.role_changed', {
        memberId: 'bob', previousRole: 'admin', newRole: 'member', changedBy: 'alice',
      });
    }
    return originalHead(subject, deadline);
  }
  vi.spyOn(context.nats.store, 'head').mockImplementation(changeFormerSuccessor);
  try {
    await runOperation(context, operation);
    expect(changed).toBe(true);
  } finally {
    await context.close();
  }
}
it.each(['role', 'turn'] as const)(
  'former successor activity does not refuse another member’s %s', unrelatedFormerSuccessor,
  120_000);

async function slowConfirmationHistory(operation: Operation) {
  const context = await fixture();
  const read = context.nats.store.readStream.bind(context.nats.store);
  const realNow = performance.now.bind(performance);
  let elapsed = 0;
  let delayedReads = 0;
  function now() {
    return realNow() + elapsed;
  }
  async function* slowOwnership(...args: Parameters<typeof read>) {
    if (args[0] === 'ownership-test') {
      elapsed += 2100;
      delayedReads++;
    }
    yield* read(...args);
  }
  vi.spyOn(performance, 'now').mockImplementation(now);
  vi.spyOn(context.nats.store, 'readStream').mockImplementation(slowOwnership);
  try {
    await runOperation(context, operation);
    expect(delayedReads).toBeGreaterThan(0);
  } finally {
    await context.close();
  }
}
it.each(['role', 'turn'] as const)(
  'slow confirmation history leaves a fresh two-second window for a %s', slowConfirmationHistory,
  120_000);
