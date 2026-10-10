import { expect, it, vi } from 'vitest';
import { countReads, event, expectNoWholeReads, natsFixture } from '@opencrane/event-store/testing';
import { readStreamSummary, type StoredEvent } from '@opencrane/event-store';
import { decisionChatSummary } from '../src/decision-summary.ts';
import { outputReportTypes } from '../src/authority.ts';
import { decisionActivity } from '../src/decision-activity.ts';
import { envelope } from '../src/actor.ts';

function activityEvent(id: string, subject: string, type: string) {
  const fixtureEvent = event(id, subject, type);
  const { memberId: _memberId, ...data } = fixtureEvent.data;
  return { ...fixtureEvent, data };
}

async function readsOnlyNewActivity() {
  const nats = await natsFixture();
  try {
    const events = [];
    for (let index = 0; index < 500; index++) {
      events.push(activityEvent(`output-${index}`, 'conversation-chat', 'agent.output_lost'));
    }
    for (let index = 0; index < 500; index++) {
      events.push(activityEvent(`start-${index}`, 'computer-assistant', 'computer.turn_started'));
      events.push(activityEvent(`close-${index}`, 'computer-assistant', 'computer.turn_closed'));
    }
    const budget = { ...event('budget', 'budget-test'), type: 'budget.ceiling_set',
      data: { scope: 'global', ceilingCents: 20000, setBy: 'alice' } };
    events.push(budget);
    await nats.seed(events);
    await decisionActivity(nats.store, 'test', 'assistant', 'chat', 'turn', Infinity);
    const reads = countReads(nats.store);
    await decisionActivity(nats.store, 'test', 'assistant', 'chat', 'turn',
      performance.now() + 2000);
    function isContentRead(call: typeof reads.calls[number]) {
      return call.subject !== 'participation-chat';
    }
    const contentReads = reads.calls.filter(isContentRead);
    expectNoWholeReads(contentReads);
    for (const call of contentReads) {
      expect(call.fromSequence).toBeGreaterThan(1);
      expect(call.rows).toBe(0);
    }
  } finally {
    await nats.close();
  }
}
it('reads only new chat and computer activity within the decision budget', readsOnlyNewActivity);

async function keepsOnlyDecisionFacts() {
  const nats = await natsFixture();
  try {
    const created = activityEvent('created', 'conversation-chat', 'conversation.created');
    const posted = activityEvent('message', 'conversation-chat', 'message.posted');
    const stopped = activityEvent('stop', 'conversation-chat', 'agent.turn_stop_requested');
    const events = [created, posted];
    for (const type of outputReportTypes) {
      events.push(activityEvent(type, 'conversation-chat', type));
    }
    events.push(stopped);
    await nats.seed(events);
    const activity = await decisionActivity(nats.store, 'test', 'assistant', 'chat', 'turn', Infinity);
    function eventId(row: (typeof activity.conversation)[number]) {
      return row.event.id;
    }
    expect(activity.conversation.map(eventId)).toEqual(['created', 'message', 'stop']);
    expect(activity.conversation[1]?.event.data).toEqual({ conversationId: 'conv_1' });
    expect(activity.conversation[0]?.event).toEqual(created);
    expect(activity.conversation[2]?.event).toEqual(stopped);
  } finally {
    await nats.close();
  }
}
it('keeps decision events in order without output reports or message text', keepsOnlyDecisionFacts);

async function honoursCapturedPositionAndConfirmsLaterChanges() {
  const nats = await natsFixture();
  try {
    const created = activityEvent('created', 'conversation-chat', 'conversation.created');
    await nats.seed([created]);
    const head = nats.store.head.bind(nats.store);
    let inserted = false;
    async function appendAfterCapturedHead(...args: Parameters<typeof head>) {
      const position = await head(...args);
      if (args[0] === undefined && !inserted) {
        inserted = true;
        const closed = activityEvent('closed', 'participation-chat', 'conversation.closed');
        await nats.seed([closed]);
      }
      return position;
    }
    const heads = vi.spyOn(nats.store, 'head');
    heads.mockImplementation(appendAfterCapturedHead);
    const activity = await decisionActivity(nats.store, 'test', 'assistant', 'chat', 'turn', Infinity);
    expect(activity.conversation).toHaveLength(1);
    expect(activity.conversation[0]?.event.id).toBe('created');
    await expect(activity.confirm(Infinity, false)).rejects.toThrow('Authority changed');
    heads.mockRestore();
  } finally {
    await nats.close();
  }
}
it('cuts chat facts at the captured position and refuses a later close',
  honoursCapturedPositionAndConfirmsLaterChanges);

async function refusesSwitchOnDuringActivityCheck() {
  const nats = await natsFixture();
  try {
    const activity = await decisionActivity(nats.store, 'test', 'assistant', 'chat', 'turn',
      Infinity);
    expect(activity.managedCallsEnabled).toBe(false);
    const payload = {
      providerId: 'primary', revision: 1, changedBy: 'alice', expectedProviderSequence: 0,
    };
    const marker = envelope('test', 'budget-test', 'provider.managed_calls_enabled', payload);
    const command = { event: marker, expectedSequence: 0 };
    expect((await nats.store.append(command)).status).toBe('appended');
    await expect(activity.confirm(Infinity, false)).rejects.toThrow('Provider setup changed');
  } finally {
    await nats.close();
  }
}
it('refuses a mode change during the activity check without attempting a budget write',
  refusesSwitchOnDuringActivityCheck);

async function keepsLongChatsWarm() {
  const nats = await natsFixture();
  const fromPositions: { subject: string; from: number }[] = [];
  const chatHead = 210001;
  function head() {
    return Promise.resolve(chatHead);
  }
  async function* readStream(subject: string, from = 1) {
    fromPositions.push({ subject, from });
    await Promise.resolve();
    if (!subject.startsWith('conversation-')) return;
    let sequence = 1;
    const created = activityEvent('created', subject, 'conversation.created');
    if (sequence >= from) yield { sequence, event: created };
    for (let turn = 0; turn < 10000; turn++) {
      const types = ['message.posted', 'agent.turn_started', 'agent.turn_completed'];
      for (const type of types) {
        sequence++;
        if (sequence < from) continue;
        const event = activityEvent(`${type}-${turn}`, subject, type);
        yield { sequence, event };
      }
      if (turn >= 600) continue;
      for (let chunk = 0; chunk < 300; chunk++) {
        sequence++;
        if (sequence < from) continue;
        const event = activityEvent(`reply-${turn}-${chunk}`, subject, 'agent.message_delta');
        yield { sequence, event };
      }
    }
  }
  const store = nats.store;
  store.head = head;
  store.readStream = readStream;
  try {
    for (const chat of ['first', 'second']) {
      const activity = await decisionActivity(store, 'test', 'assistant', chat, 'turn', Infinity);
      expect(activity.conversation).toHaveLength(30001);
    }
    fromPositions.length = 0;
    for (const chat of ['first', 'second']) {
      const activity = await decisionActivity(store, 'test', 'assistant', chat, 'turn',
        performance.now() + 2000);
      expect(activity.conversation).toHaveLength(30001);
      expect(activity.conversation[0]?.event.id).toBe('created');
      expect(activity.conversation.at(-1)?.event.id).toBe('agent.turn_completed-9999');
    }
    function isConversationRead(call: (typeof fromPositions)[number]) {
      return call.subject.startsWith('conversation-');
    }
    const chatReads = fromPositions.filter(isConversationRead);
    expect(chatReads).toEqual([
      { subject: 'conversation-first', from: 210002 },
      { subject: 'conversation-second', from: 210002 },
    ]);
  } finally {
    await nats.close();
  }
}
it('keeps two 10,000-turn chats with 600 long replies each on the decision tail-read path',
  keepsLongChatsWarm);

async function boundsRetainedDecisionRows() {
  const fromPositions: number[] = [];
  async function* readStream(_subject: string, from = 1) {
    fromPositions.push(from);
    await Promise.resolve();
    for (let index = 0; index < 70000; index++) {
      const event = activityEvent(`message-${index}`, 'conversation-chat', 'message.posted');
      if (index + 1 >= from) yield { sequence: index + 1, event };
    }
  }
  const store = { readStream };
  function decisionFacts(rows: StoredEvent[]) {
    return { count: rows.length, first: rows[0]?.event.id, last: rows.at(-1)?.event.id };
  }
  const expected = { count: 70000, first: 'message-0', last: 'message-69999' };
  expect(await readStreamSummary(store, 'test', 'conversation-chat',
    decisionChatSummary, Infinity, decisionFacts)).toEqual(expected);
  expect(await readStreamSummary(store, 'test', 'conversation-chat',
    decisionChatSummary, Infinity, decisionFacts)).toEqual(expected);
  expect(fromPositions).toEqual([1, 1]);
}
it('bounds retained decision rows without forgetting old approval activity',
  boundsRetainedDecisionRows);
