import { dirname } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { event, natsFixture } from '@opencrane/event-store/testing';
import { conversationKeys } from '../src/chat/keys.ts';
import { recordReport } from '../src/chat/reports.ts';
import { chatHistory } from '../src/chat/commands.ts';

let nats: Awaited<ReturnType<typeof natsFixture>>;
const context = { silo: 'test', assistantId: 'assistant', computerId: 'computer' };
const admitted = { assistantId: 'assistant', computerId: 'computer', conversationId: 'child',
  turnId: 'input', requesterId: 'alice', threadId: 'shared-thread', task: 'chat_turn',
  executionMode: 'restricted', contextClass: 'shared_only' };
const output = { assistantId: 'assistant', conversationId: 'child', turnId: 'input',
  requesterId: 'alice', threadId: 'shared-thread', executionMode: 'restricted',
  type: 'agent.message_completed', messageId: 'reply', text: 'Shared answer',
  sequence: 1, previousSequence: 0 };

async function close() {
  await nats?.close();
}
afterEach(close);

async function setup(start: Record<string, unknown> | undefined, source = 'opencrane-server') {
  nats = await natsFixture();
  const keys = conversationKeys(`${dirname(nats.env().NATS_CA_FILE)}/keys`);
  keys.provision('test', 'child');
  const creation = { conversationId: 'child', createdBy: 'alice', mode: 'agent_session',
    contextKind: 'shared_child', assistantId: 'assistant', payingGroupId: 'sales',
    initialJoins: [{ participantId: 'alice', parentJoinEventId: 'join', parentJoinPosition: 1 }],
    origin: { parentConversationId: 'parent', sourceMessageId: 'source', sourcePosition: 2,
      intentEventId: 'intent', intentPosition: 3, requestId: 'request', firstInputId: 'input' } };
  const message = { conversationId: 'child', authorId: 'alice', authorKind: 'human',
    contentType: 'text', ...keys.encrypt('test', 'child', 'Shared question') };
  const rows = [
    { ...event('created', 'conversation-child', 'conversation.created'), data: creation },
    { ...event('input', 'conversation-child', 'message.posted'), data: message },
  ];
  await nats.seed(rows);
  if (start) {
    const saved = { ...event('start', 'computer-assistant', 'computer.turn_started'),
      source, data: start };
    await nats.seed([saved]);
  }
  return keys;
}

const refusals = [
  { name: 'no admitted start', start: undefined, patch: {} },
  { name: 'a private thread', start: admitted, patch: { threadId: 'private-thread' } },
  { name: 'no reported thread', start: admitted, patch: { threadId: undefined } },
  { name: 'a private turn', start: { ...admitted, turnId: 'private-input' }, patch: {} },
  { name: 'a private saved class', start: { ...admitted, contextClass: undefined }, patch: {} },
  { name: 'another conversation', start: { ...admitted, conversationId: 'private' }, patch: {} },
  { name: 'another computer', start: { ...admitted, computerId: 'other' }, patch: {} },
  { name: 'another requester', start: { ...admitted, requesterId: 'bob' }, patch: {} },
  { name: 'a supplied output class', start: admitted, patch: { contextClass: 'shared_only' } },
];
async function refusesOutput(test: typeof refusals[number]) {
  const keys = await setup(test.start);
  const report = { ...output, ...test.patch };
  await expect(recordReport(nats.store, keys, context, report)).rejects.toThrow();
  expect(await chatHistory(nats.store, 'test', 'child')).toHaveLength(2);
}
it.each(refusals)('refuses child output with $name before saving text', refusesOutput);

async function refusesUntrustedStart() {
  const keys = await setup(admitted, 'computer-bridge');
  await expect(recordReport(nats.store, keys, context, output)).rejects.toThrow();
  expect(await chatHistory(nats.store, 'test', 'child')).toHaveLength(2);
}
it('refuses output when the first saved start was not admitted by the server', refusesUntrustedStart);

async function acceptsOutputAndReplay() {
  const keys = await setup(admitted);
  expect(await recordReport(nats.store, keys, context, output)).toBe('recorded');
  const closed = { ...event('close', 'computer-assistant', 'computer.turn_closed'),
    data: { ...admitted, status: 'completed' } };
  await nats.seed([closed]);
  expect(await recordReport(nats.store, keys, context, output)).toBe('duplicate');
  const changed = { ...output, text: 'Substituted private text' };
  await expect(recordReport(nats.store, keys, context, changed)).rejects.toThrow();
  const next = { ...output, sequence: 2, previousSequence: 1 };
  await expect(recordReport(nats.store, keys, context, next)).rejects.toThrow();
  expect(await chatHistory(nats.store, 'test', 'child')).toHaveLength(3);
}
it('saves admitted shared output and only accepts its exact replay after closure',
  acceptsOutputAndReplay);
