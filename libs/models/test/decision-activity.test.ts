import { expect, it, vi } from 'vitest';
import { countReads, event, expectNoWholeReads, natsFixture } from '@opencrane/event-store/testing';
import { readStreamSummary, type StoredEvent } from '@opencrane/event-store';
import { decisionChatSummary } from '../src/decision-summary.ts';
import { outputReportTypes } from '../src/authority.ts';
import { decisionActivity } from '../src/decision-activity.ts';

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
    await nats.seed(events);
    await decisionActivity(nats.store, 'test', 'assistant', 'chat', 'turn', Infinity);
    const reads = countReads(nats.store);
    await decisionActivity(nats.store, 'test', 'assistant', 'chat', 'turn',
      performance.now() + 2000);
    expectNoWholeReads(reads.calls);
    for (const call of reads.calls) {
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
        const closed = activityEvent('closed', 'conversation-chat', 'conversation.closed');
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

async function boundsRetainedDecisionRows() {
  const fromPositions: number[] = [];
  async function* readStream(_subject: string, from = 1) {
    fromPositions.push(from);
    await Promise.resolve();
    for (let index = 0; index < 30001; index++) {
      const event = activityEvent(`message-${index}`, 'conversation-chat', 'message.posted');
      if (index + 1 >= from) yield { sequence: index + 1, event };
    }
  }
  const store = { readStream };
  function decisionFacts(rows: StoredEvent[]) {
    return { count: rows.length, first: rows[0]?.event.id, last: rows.at(-1)?.event.id };
  }
  const expected = { count: 30001, first: 'message-0', last: 'message-30000' };
  expect(await readStreamSummary(store, 'test', 'conversation-chat',
    decisionChatSummary, Infinity, decisionFacts)).toEqual(expected);
  expect(await readStreamSummary(store, 'test', 'conversation-chat',
    decisionChatSummary, Infinity, decisionFacts)).toEqual(expected);
  expect(fromPositions).toEqual([1, 1]);
}
it('bounds retained decision rows without forgetting old approval activity',
  boundsRetainedDecisionRows);
