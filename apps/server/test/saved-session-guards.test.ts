import { afterAll, beforeAll, expect, it } from 'vitest';
import { BudgetActor, groupMembership, history } from '@opencrane/models';
import { chatHistory } from '../src/chat/commands.ts';
import { turnCommand, type ExecutionMode } from '../src/chat/turns.ts';
import { saveInput, saveSession, savedSessionFixture } from './support/saved-session.ts';

let fixture: Awaited<ReturnType<typeof savedSessionFixture>>;
async function initialise() {
  fixture = await savedSessionFixture();
  await new BudgetActor(fixture.nats.store, 'test').start(2000, 20000, 'payer');
}
async function close() {
  await fixture?.close();
}
beforeAll(initialise, 120_000);
afterAll(close);

const cases = [
  { mode: 'restricted' as const, child: false },
  { mode: 'memory_free' as const, child: false },
  { mode: 'restricted' as const, child: true },
];

async function refusesSavedPayerWrite(testCase: { mode: ExecutionMode; child: boolean }) {
  const conversationId = `write-${testCase.mode}-${testCase.child}`;
  await saveSession(fixture, { conversationId, ...testCase, payer: 'other-payer' });
  for (const groupId of ['owners', 'payer', 'other-payer']) {
    await groupMembership(fixture.nats.store, 'test', 'alice', groupId, fixture.auth.binding);
  }
  expect((await fixture.auth.actsFor('alice', 'helper')).allowed).toBe(true);
  const before = await chatHistory(fixture.nats.store, 'test', conversationId);
  const payload = { id: `message-${conversationId}`, text: 'Must not be saved',
    ...(testCase.mode === 'memory_free' ? { executionMode: testCase.mode } : {}) };
  const response = await fixture.request(conversationId, 'messages', payload);
  expect(response.statusCode, response.body).toBe(403);
  expect(response.json()).toMatchObject({ status: 'refused' });
  expect(await chatHistory(fixture.nats.store, 'test', conversationId)).toEqual(before);
}
it.each(cases)('refuses a saved payer mismatch on write: $mode child=$child',
  refusesSavedPayerWrite);

async function refusesSavedPayerStart(testCase: { mode: ExecutionMode; child: boolean }) {
  const conversationId = `start-${testCase.mode}-${testCase.child}`;
  await saveSession(fixture, { conversationId, ...testCase, payer: 'other-payer' });
  const message = await saveInput(fixture, conversationId, testCase.mode);
  const context = { silo: 'test', assistantId: 'helper', computerId: 'computer',
    binding: fixture.auth.binding };
  const input = { conversationId, turnId: message.id, threadId: conversationId,
    status: 'started' as const, executionMode: testCase.mode };
  const before = await history(fixture.nats.store, 'computer-helper', 'test');
  await expect(turnCommand(fixture.nats.store, context, input))
    .rejects.toThrow('Paying group does not match the assistant');
  expect(await history(fixture.nats.store, 'computer-helper', 'test')).toEqual(before);
}
it.each(cases)('refuses a saved payer mismatch on start: $mode child=$child',
  refusesSavedPayerStart);
