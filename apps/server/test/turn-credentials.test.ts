import { dirname } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { natsFixture } from '@opencrane/event-store/testing';
import { envelope } from '@opencrane/models';
import { fixture } from '../../computer/test/bridge-gate-fixture.ts';
import { conversationKeys } from '../src/chat/keys.ts';
import { readChatFacts } from '../src/chat/chat-summary.ts';
import { recordReport } from '../src/chat/reports.ts';
import { releaseTurnCredentials } from '../src/chat/turn-credentials.ts';

let nats: Awaited<ReturnType<typeof natsFixture>>;
let computer: Awaited<ReturnType<typeof fixture>>;
let keys: ReturnType<typeof conversationKeys>;
const context = { silo: 'test', assistantId: 'assistant', computerId: 'computer' };
const turn = { conversationId: 'chat', turnId: 'turn', threadId: 'thread',
  requesterId: 'alice', task: 'chat_turn' as const, executionMode: 'restricted' as const };

async function setup() {
  nats = await natsFixture();
  computer = await fixture(false);
  keys = conversationKeys(`${dirname(nats.env().NATS_CA_FILE)}/keys`);
  keys.provision('test', 'chat');
  const member = envelope('test', 'member-alice', 'member.joined', { memberId: 'alice',
    email: 'alice@example.test', displayName: 'Alice', role: 'member' });
  const assistant = envelope('test', 'assistant-assistant', 'assistant.created', {
    assistantId: 'assistant', ownerId: 'alice', kind: 'personal' });
  const claimed = envelope('test', 'computer-assistant', 'computer.claimed', {
    assistantId: 'assistant', computerId: 'computer', generation: 1,
    sandboxUid: 'sandbox', tokenId: 'token:fixture' });
  const ready = envelope('test', 'computer-assistant', 'computer.ready', {
    assistantId: 'assistant', computerId: 'computer', generation: 1 });
  const created = envelope('test', 'conversation-chat', 'conversation.created', {
    conversationId: 'chat', createdBy: 'alice', assistantId: 'assistant', mode: 'agent_session' });
  const message = envelope('test', 'conversation-chat', 'message.posted', {
    conversationId: 'chat', authorId: 'alice', authorKind: 'human', contentType: 'text',
    ...keys.encrypt('test', 'chat', 'New question') }, 'turn');
  const admitted = envelope('test', 'computer-assistant', 'computer.turn_started', {
    ...turn, assistantId: 'assistant', computerId: 'computer' });
  await nats.seed([member, assistant, claimed, ready, created, message, admitted]);
}

async function cleanup() {
  vi.restoreAllMocks();
  await computer?.close();
  await nats?.close();
}
beforeEach(setup);
afterEach(cleanup);

async function refusesRetryWithoutInitialDependencies(retrySequence: number) {
  const options = { silo: 'test', store: nats.store, keys };
  const signed = vi.spyOn(computer.issuer, 'turn');
  const delivered = vi.fn();
  for (const sequence of [1, retrySequence]) {
    const report = { conversationId: turn.conversationId, turnId: turn.turnId,
      threadId: turn.threadId, assistantId: 'assistant', type: 'agent.turn_started',
      executionMode: turn.executionMode, sequence, previousSequence: sequence - 1 };
    const result = await recordReport(nats.store, keys, context, report);
    const delivery = { ...report, replay: result === 'duplicate' };
    const acknowledgement: Record<string, unknown> = {};
    await releaseTurnCredentials(options, context, computer.issuer, delivery,
      turn, acknowledgement, delivered);
    expect(acknowledgement).toEqual({ refused: 'memory_context_unavailable' });
    const facts = await readChatFacts(nats.store, 'test', 'chat', 'turn');
    expect(facts.memoryContext).toBeUndefined();
  }
  expect(signed).not.toHaveBeenCalled();
  expect(delivered).not.toHaveBeenCalled();
}
it.each([1, 2])('refuses report %i after initial delivery lacked its dependencies',
  refusesRetryWithoutInitialDependencies);
