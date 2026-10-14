import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { history, providerTurnAdmission, turnBudgetStop } from '@opencrane/models';
import { fixture } from '@opencrane/models/testing';
import { turnCommand } from '../src/chat/turns.ts';

let setup: Awaited<ReturnType<typeof fixture>>;
const context = { silo: 'test', assistantId: 'assistant', computerId: 'computer' };
let input: { conversationId: string; turnId: string; threadId: string; status: 'started' };
let position: number;
const limit = { scope: 'paying_group', scopeId: 'personal-default', setBy: 'alice' };

async function initialise() {
  setup = await fixture();
  const queued = await setup.append('conversation-conversation', 'message.posted', {
    conversationId: 'conversation', authorKind: 'human', authorId: 'alice',
    ciphertext: 'ZmFrZS1jaXBoZXJ0ZXh0', keyId: 'key:1', contentType: 'text' });
  input = { conversationId: 'conversation', turnId: queued.id,
    threadId: 'queued-thread', status: 'started' };
  const rows = await history(setup.nats.store, 'conversation-conversation', 'test');
  position = rows.at(-1)!.sequence;
}
async function close() {
  vi.restoreAllMocks();
  await setup?.close();
}
beforeEach(initialise);
afterEach(close);

async function stopped() {
  await setup.actor.configure({ ...limit, ceilingCents: 0 });
  return setup.actor.state.stops.at(-1)!.id;
}
async function recover() {
  await setup.actor.configure({ ...limit, ceilingCents: 20000 });
}
async function callQueued() {
  const claims = { ...setup.t, turn: input.turnId, thread: input.threadId };
  const token = await setup.sign(claims, 'decision-service');
  return setup.call({ 'x-turn-token': token, 'session-id': input.threadId });
}
async function expectNoSend() {
  const reply = await callQueued();
  expect(reply.status).not.toBe(200);
  expect(setup.received()).toBe(0);
  expect(setup.actor.state.reservations).toEqual([]);
  expect(setup.actor.state.dispatches).toEqual([]);
}
async function turnRecords(type: 'computer.turn_started' | 'computer.turn_closed') {
  const rows = await history(setup.nats.store, 'computer-assistant', 'test');
  function matchesQueued(row: typeof rows[number]) {
    const fields = z.object({ turnId: z.string().optional() }).parse(row.event.data);
    return row.event.type === type && fields.turnId === input.turnId;
  }
  return rows.filter(matchesQueued);
}

async function refusesChangedDefault() {
  const stopId = await stopped();
  await setup.actor.configure({ scope: 'global', ceilingCents: 20000,
    dailyCeilingCents: 2000, defaultPayingGroupId: 'other', setBy: 'alice' });
  const queued = { ...input, position };
  const admission = await providerTurnAdmission(setup.nats.store, 'test', 'assistant',
    performance.now() + 10_000, queued);
  expect(admission).toMatchObject({ defaultPayingGroupId: 'personal-default', stopId });
  const work = { ...input, assistantId: 'assistant',
    payingGroupId: admission.defaultPayingGroupId };
  expect(await turnBudgetStop(setup.nats.store, 'test', work, position,
    performance.now() + 10_000)).toBe(stopId);
  await expect(turnCommand(setup.nats.store, context, input)).rejects.toThrow('spending');
  await expect(turnCommand(setup.nats.store, context, input)).rejects.toThrow('refused');
  await expectNoSend();
}
it('keeps the queued payer after its stop and a default change before fan-out',
  refusesChangedDefault);

async function refusesPausedAppend() {
  const append = setup.nats.store.append.bind(setup.nats.store);
  let paused = false;
  let dispatchStatus: number | undefined;
  async function pauseAppend(command: Parameters<typeof append>[0]) {
    const candidate = z.object({ type: z.string() }).parse(command.event);
    if (candidate.type !== 'computer.turn_started' || paused) return append(command);
    paused = true;
    await stopped();
    await recover();
    const result = await append(command);
    const reply = await callQueued();
    dispatchStatus = reply.status;
    return result;
  }
  const appendSpy = vi.spyOn(setup.nats.store, 'append');
  appendSpy.mockImplementation(pauseAppend);
  await expect(turnCommand(setup.nats.store, context, input)).rejects.toThrow('spending');
  expect(paused).toBe(true);
  expect(dispatchStatus).not.toBe(200);
  await expect(turnCommand(setup.nats.store, context, input)).rejects.toThrow('spending');
  await expectNoSend();
}
it('refuses admission and send permission after stop and recovery during the computer append',
  refusesPausedAppend);

const lateStartChecks = ['renewal', 'dispatch'] as const;
async function refusesLateStartRenewal(check: typeof lateStartChecks[number]) {
  await stopped();
  await recover();
  await setup.append('computer-assistant', 'computer.turn_started', {
    conversationId: input.conversationId, turnId: input.turnId, threadId: input.threadId,
    assistantId: 'assistant', computerId: 'computer', requesterId: 'alice',
    task: 'chat_turn', payingGroupId: 'personal-default' });
  expect(setup.actor.state.stoppedWork).toEqual([]);
  if (check === 'renewal') {
    await expect(turnCommand(setup.nats.store, context, input)).rejects.toThrow('spending');
    expect(await turnRecords('computer.turn_closed')).toHaveLength(1);
  }
  await expectNoSend();
}
it.each(lateStartChecks)('uses the queued position for %s of a start saved after recovery',
  refusesLateStartRenewal);

async function initialCheckClosesRefusedTurn() {
  await stopped();
  await expect(turnCommand(setup.nats.store, context, input)).rejects.toThrow('spending');
  // Require the initial refusal to save closure; a later refusal alone cannot do this.
  const closed = await turnRecords('computer.turn_closed');
  expect(closed).toHaveLength(1);
  expect(closed[0]!.event.data).toMatchObject({ status: 'failed' });
  await expectNoSend();
}
it('saves a failed close at the initial stop check before the final recheck',
  initialCheckClosesRefusedTurn);

async function finalCheckSeesNewStop() {
  const head = setup.nats.store.head.bind(setup.nats.store);
  let inserted = false;
  async function insertStop(...args: Parameters<typeof head>) {
    if (args[0] === 'member-alice' && !inserted) {
      inserted = true;
      await stopped();
      await recover();
    }
    return head(...args);
  }
  const headSpy = vi.spyOn(setup.nats.store, 'head');
  headSpy.mockImplementation(insertStop);
  await expect(turnCommand(setup.nats.store, context, input)).rejects.toThrow('spending');
  expect(inserted).toBe(true);
  expect(await turnRecords('computer.turn_started')).toEqual([]);
  expect(await turnRecords('computer.turn_closed')).toEqual([]);
  await expectNoSend();
}
it('rechecks a stop saved after the initial budget read during the access check',
  finalCheckSeesNewStop);

async function keepsProviderSwitchSendRefusal() {
  const append = setup.nats.store.append.bind(setup.nats.store);
  let switched = false;
  async function switchDuringAppend(command: Parameters<typeof append>[0]) {
    const candidate = z.object({ type: z.string() }).parse(command.event);
    if (candidate.type === 'computer.turn_started' && !switched) {
      switched = true;
      await setup.append('budget-test', 'provider.managed_calls_enabled', {
        providerId: 'primary', revision: 1, changedBy: 'alice', expectedProviderSequence: 0 });
    }
    return append(command);
  }
  const appendSpy = vi.spyOn(setup.nats.store, 'append');
  appendSpy.mockImplementation(switchDuringAppend);
  const admitted = await turnCommand(setup.nats.store, context, input);
  expect(switched).toBe(true);
  expect(admitted).toMatchObject({ payingGroupId: 'personal-default' });
  expect(admitted).not.toHaveProperty('providerId');
  await expectNoSend();
}
it('keeps the saved legacy binding while a provider switch refuses its send',
  keepsProviderSwitchSendRefusal);
