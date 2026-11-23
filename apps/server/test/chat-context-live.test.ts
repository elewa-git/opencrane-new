import { once } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { until } from '@opencrane/authz/testing';
import { personalContext } from '../src/chat/context.ts';
import { chatContextFixture } from './support/chat-context-fixture.ts';

let fixture: Awaited<ReturnType<typeof chatContextFixture>>;
async function setup(): Promise<void> {
  fixture = await chatContextFixture();
}
beforeEach(setup, 120_000);
async function cleanup(): Promise<void> {
  vi.restoreAllMocks();
  await fixture?.close();
}
afterEach(cleanup);

async function followsProvisioning(): Promise<void> {
  const { socket, messages, firstOutcome } = await fixture.connect();
  await firstOutcome;
  expect(messages[0]).toMatchObject({ type: 'context', topic: 'chat-context',
    data: { memberId: 'alice', assistantId: null, role: 'member' } });
  await fixture.assistant('personal', 'alice');
  function assignmentReceived(): boolean {
    return messages.length > 1;
  }
  await until(assignmentReceived);
  expect(messages.at(-1)).toMatchObject({ type: 'context', topic: 'chat-context',
    data: { memberId: 'alice', assistantId: 'personal' } });
  const closed = once(socket, 'close');
  await fixture.remove('alice');
  expect((await closed)[0]).toBe(1008);
}
it('delivers assignment through a real identity binding, then revokes access', followsProvisioning);

async function refusesNonMember(): Promise<void> {
  const { messages, firstOutcome } = await fixture.connect('outsider');
  expect((await firstOutcome)[0]).toBe(1008);
  expect(messages).toEqual([]);
}
it('refuses an identity with no member binding without delivering context', refusesNonMember);

async function separatesActivePeople(): Promise<void> {
  await fixture.assistant('bob-personal', 'bob');
  const bob = await fixture.connect('identity-bob');
  await bob.firstOutcome;
  expect(bob.messages[0]).toMatchObject({ data: {
    memberId: 'bob', assistantId: 'bob-personal',
  } });
  const alice = await fixture.connect();
  await alice.firstOutcome;
  expect(alice.messages[0]).toMatchObject({ data: { memberId: 'alice', assistantId: null } });
  await fixture.assistant('alice-personal', 'alice');
  function aliceAssigned(): boolean {
    return alice.messages.length > 1;
  }
  await until(aliceAssigned);
  expect(alice.messages.at(-1)).toMatchObject({ data: {
    memberId: 'alice', assistantId: 'alice-personal',
  } });
  expect(bob.messages).toHaveLength(1);
}
it('delivers only each active person’s own assignment', separatesActivePeople);

async function refusesDeniedAssistant(): Promise<void> {
  await fixture.assistant('denied-personal', 'alice', false);
  const { messages, firstOutcome } = await fixture.connect();
  await firstOutcome;
  expect(messages[0]).toMatchObject({ data: { memberId: 'alice', assistantId: null } });
  expect(await personalContext(fixture.chat, 'alice')).toMatchObject({ assistantId: null });
}
it('withholds a projected assistant when acts_for permission is denied', refusesDeniedAssistant);

async function filtersOwnership(): Promise<void> {
  await fixture.assistant('bob-personal', 'bob');
  await fixture.permitAssistant('alice', 'bob-personal');
  expect(await personalContext(fixture.chat, 'alice')).toMatchObject({ assistantId: null });
  expect(await personalContext(fixture.chat, 'bob')).toMatchObject({ assistantId: 'bob-personal' });
}
it('filters personal ownership even when another assistant permits acts_for', filtersOwnership);

async function separatesSilos(): Promise<void> {
  const other = await fixture.foreignAssistant();
  for (const silo of ['test', 'other']) {
    await fixture.permitAssistant('alice', 'foreign', silo);
  }
  expect(await personalContext(other, 'alice')).toMatchObject({ assistantId: 'foreign' });
  expect(await personalContext(fixture.chat, 'alice')).toMatchObject({ assistantId: null });
}
it('selects context from the requested silo when member ids match', separatesSilos);

async function expiresWhileSubscribed(): Promise<void> {
  const { socket, messages, firstOutcome } = await fixture.connect();
  await firstOutcome;
  expect(messages).toHaveLength(1);
  const nextOutcome = Promise.race([once(socket, 'close'), once(socket, 'message')]);
  vi.spyOn(Date, 'now').mockReturnValue(2000000000000);
  await fixture.assistant('expired-personal', 'alice');
  expect((await nextOutcome)[0]).toBe(1008);
  expect(messages).toHaveLength(1);
}
it('refuses an expired session while already subscribed', expiresWhileSubscribed);

async function refusesChangedOrganisation(): Promise<void> {
  const { socket, messages, firstOutcome } = await fixture.connect();
  await firstOutcome;
  const nextOutcome = Promise.race([once(socket, 'close'), once(socket, 'message')]);
  fixture.config.expectedOrgId = 'another-organisation';
  await fixture.assistant('wrong-org-personal', 'alice');
  expect((await nextOutcome)[0]).toBe(1008);
  expect(messages).toHaveLength(1);
}
it('rechecks the organisation pin while subscribed', refusesChangedOrganisation);

async function refusesChangedSilo(): Promise<void> {
  await fixture.foreignAssistant();
  await fixture.permitAssistant('alice', 'mixed-personal', 'other');
  const { socket, messages, firstOutcome } = await fixture.connect();
  await firstOutcome;
  const nextOutcome = Promise.race([once(socket, 'close'), once(socket, 'message')]);
  fixture.chat.binding.silo = 'other';
  await fixture.assistant('mixed-personal', 'alice');
  expect((await nextOutcome)[0]).toBe(1008);
  expect(messages).toHaveLength(1);
}
it('refuses a silo that no longer matches its permission binding', refusesChangedSilo);

async function checksBeforeContent(): Promise<void> {
  const { socket, messages, firstOutcome } = await fixture.connect();
  await firstOutcome;
  const before = fixture.reads.count();
  const closed = once(socket, 'close');
  await fixture.remove('alice');
  expect((await closed)[0]).toBe(1008);
  expect(messages).toHaveLength(1);
  expect(fixture.reads.count()).toBe(before);
}
it('checks active membership before reading personal content', checksBeforeContent);

async function removesDuringRead(): Promise<void> {
  await fixture.assistant('alice-personal', 'alice');
  const entered = fixture.reads.hold();
  const { socket, messages, firstOutcome } = await fixture.connect();
  await entered;
  await fixture.remove('alice');
  fixture.reads.release();
  expect((await firstOutcome)[0]).toBe(1008);
  expect(messages).toEqual([]);
  expect(socket.readyState).toBe(socket.CLOSED);
}
it('refuses delivery when membership is removed during a delayed context read', removesDuringRead);
