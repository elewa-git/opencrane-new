import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { conversations } from '@opencrane/projections';
import type { EventEnvelope } from '@opencrane/events';
import { budgetStopHandler, history } from '../src/index.ts';
import { fixture } from './fixture.ts';

let setup: Awaited<ReturnType<typeof fixture>>;
async function initialise() {
  setup = await fixture();
  await setup.runner.initialise(conversations);
}
async function close() {
  vi.restoreAllMocks();
  await setup?.close();
}
beforeEach(initialise);
afterEach(close);

async function stop(scope = 'paying_group', scopeId = 'personal-default') {
  const limit = scope === 'global'
    ? { scope, ceilingCents: 0, setBy: 'alice' }
    : { scope, scopeId, ceilingCents: 0, setBy: 'alice' };
  await setup.actor.configure(limit);
  const rows = await history(setup.nats.store, 'budget-test', 'test');
  return rows.at(-1)!.event;
}
async function deliver(event: EventEnvelope) {
  await setup.runner.run(conversations);
  await budgetStopHandler(setup.nats.store).handle(event, setup.db);
}
async function records(conversationId = 'conversation') {
  const rows = await history(setup.nats.store, `conversation-${conversationId}`, 'test');
  function isStop(row: typeof rows[number]) {
    return row.event.type === 'agent.turn_stop_requested';
  }
  return rows.filter(isStop);
}
async function otherTurn(assistantId = 'assistant', payer = 'other') {
  await setup.append('conversation-other', 'conversation.created', {
    conversationId: 'other', assistantId, createdBy: 'alice', mode: 'agent_session' });
  await setup.append(`computer-${assistantId}`, 'computer.turn_started', {
    assistantId, computerId: 'computer', conversationId: 'other', turnId: 'other',
    threadId: 'other', requesterId: 'alice', task: 'chat_turn', payingGroupId: payer });
}

const scopes = ['paying_group', 'assistant', 'global'] as const;
async function isolatesScope(scope: typeof scopes[number]) {
  const assistantId = scope === 'assistant' ? 'other-assistant' : 'assistant';
  await otherTurn(assistantId);
  const scopeId = scope === 'assistant' ? 'assistant' : 'personal-default';
  const event = await stop(scope, scopeId);
  await deliver(event);
  expect(await records()).toHaveLength(1);
  expect((await records())[0]!.event.data).toEqual({ conversationId: 'conversation',
    turnId: 'turn', reason: 'budget', stopId: event.id });
  expect(await records('other')).toHaveLength(scope === 'global' ? 1 : 0);
  expect((await setup.call()).status).not.toBe(200);
  expect(setup.received()).toBe(0);
  if (scope === 'paying_group') {
    const claims = { ...setup.t, conversation: 'other', turn: 'other', thread: 'other' };
    const token = await setup.sign(claims, 'decision-service');
    const reply = await setup.call({ 'x-turn-token': token, 'session-id': 'other' });
    expect(reply.status).toBe(200);
    expect(setup.received()).toBe(1);
  }
}
it.each(scopes)('records only unfinished turns affected by a %s stop', isolatesScope);

async function waitsForIndex() {
  const event = await stop();
  await expect(budgetStopHandler(setup.nats.store).handle(event, setup.db))
    .rejects.toThrow('index');
  expect(await records()).toHaveLength(0);
  await deliver(event);
  expect(await records()).toHaveLength(1);
}
it('retries while the conversation index has not passed the stop', waitsForIndex);

async function queuesAndRecovers() {
  await setup.append('conversation-conversation', 'message.posted', {
    conversationId: 'conversation', authorKind: 'human', authorId: 'alice',
    ciphertext: 'ZmFrZS1jaXBoZXJ0ZXh0', keyId: 'key:1', contentType: 'text' });
  const event = await stop();
  await setup.actor.configure({ scope: 'paying_group', scopeId: 'personal-default',
    ceilingCents: 20000, setBy: 'alice' });
  await deliver(event);
  const saved = await records();
  expect(saved).toHaveLength(2);
  await setup.runner.rebuild(conversations);
  await deliver(event);
  expect(await records()).toEqual(saved);
  expect(setup.received()).toBe(0);
}
it('keeps queued messages stopped after recovery, replay and redelivery', queuesAndRecovers);

const races = ['member', 'completed', 'failed', 'lost-reply', 'two-stops'] as const;
async function handlesRaces(race: typeof races[number]) {
  const event = await stop();
  await setup.runner.run(conversations);
  const append = setup.nats.store.append.bind(setup.nats.store);
  let intercepted = false;
  async function raceAppend(command: Parameters<typeof append>[0]) {
    const candidate = command.event as EventEnvelope;
    if (candidate.type !== 'agent.turn_stop_requested' || intercepted) return append(command);
    intercepted = true;
    if (race === 'lost-reply') {
      await append(command);
      throw new Error('Reply lost');
    }
    if (race === 'two-stops') {
      await deliver(event);
    } else {
      const type = race === 'member' ? 'agent.turn_stop_requested' : `agent.turn_${race}`;
      const data = race === 'member'
        ? { conversationId: 'conversation', turnId: 'turn', requestedBy: 'alice' }
        : { conversationId: 'conversation', turnId: 'turn' };
      await setup.append('conversation-conversation', type, data);
    }
    return append(command);
  }
  vi.spyOn(setup.nats.store, 'append').mockImplementation(raceAppend);
  const handler = budgetStopHandler(setup.nats.store);
  if (race === 'lost-reply') {
    await expect(handler.handle(event, setup.db)).rejects.toThrow('Reply lost');
  } else {
    await handler.handle(event, setup.db);
  }
  await handler.handle(event, setup.db);
  const expected = race === 'completed' || race === 'failed' ? 0 : 1;
  expect(await records()).toHaveLength(expected);
}
it.each(races)('keeps one stop or the earlier terminal report during %s', handlesRaces);

async function exhaustionAndPerTurn() {
  await setup.actor.configure({ scope: 'paying_group', scopeId: 'personal-default',
    ceilingCents: 1, setBy: 'alice' });
  expect((await setup.call({}, { max_output_tokens: 100000 })).status).toBe(402);
  const rows = await history(setup.nats.store, 'budget-test', 'test');
  for (const row of rows) {
    if (row.event.type === 'budget.exhausted') await deliver(row.event);
  }
  expect(await records()).toHaveLength(1);
  expect(setup.received()).toBe(0);
}
it('handles scope exhaustion and its repeated per-turn records', exhaustionAndPerTurn);
