import { dirname } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { readEventAt, type StoredEvent, type AppendCommand } from '@opencrane/event-store';
import type { EventEnvelope } from '@opencrane/events';
import { countReads, event as fixtureEvent, expectNoWholeReads,
  natsFixture } from '@opencrane/event-store/testing';
import { conversationKeys } from '../src/chat/keys.ts';
import { recordReport } from '../src/chat/reports.ts';
import { turnCommand } from '../src/chat/turns.ts';
import { chatHistory } from '../src/chat/commands.ts';

let nats: Awaited<ReturnType<typeof natsFixture>>;
let keys: ReturnType<typeof conversationKeys>;
const context = { silo: 'test', assistantId: 'assistant', computerId: 'computer' };
const subject = 'conversation-chat';
const report = { conversationId: 'chat', turnId: 'message', assistantId: 'assistant',
  requesterId: 'alice', type: 'agent.message_delta', messageId: 'reply', text: 'Hello' };

async function close() {
  vi.restoreAllMocks();
  await nats?.close();
}
afterEach(close);

function event(id: string, type: string, data: Record<string, unknown>): EventEnvelope {
  const base = fixtureEvent(id, subject, type);
  return { ...base, data };
}
async function setup() {
  nats = await natsFixture();
  keys = conversationKeys(`${dirname(nats.env().NATS_CA_FILE)}/keys`);
  keys.provision('test', 'chat');
  const joined = fixtureEvent('joined', 'member-alice', 'member.joined');
  joined.data = { ...joined.data, memberId: 'alice' };
  await nats.seed([joined,
    event('created', 'conversation.created', {
      conversationId: 'chat', assistantId: 'assistant', createdBy: 'alice', mode: 'agent_session',
    }),
    event('message', 'message.posted', { conversationId: 'chat', authorId: 'alice',
      authorKind: 'human', contentType: 'text', ...keys.encrypt('test', 'chat', 'Hello') }),
  ]);
}
async function record(sequence: number, previousSequence: number) {
  return recordReport(nats.store, keys, context, { ...report, sequence, previousSequence });
}
async function warmReportReadsOnlyNewRows() {
  await setup();
  const events: EventEnvelope[] = [];
  for (let sequence = 1; sequence <= 498; sequence++) {
    const base = event(`output-${sequence}`, 'agent.output_lost', {
      conversationId: 'chat', turnId: 'message',
    });
    events.push({ ...base, report: { computerId: 'computer', sequence, digest: 'a'.repeat(64) } });
  }
  await nats.seed(events);
  await record(499, 498);
  const reads = countReads(nats.store);
  const append = vi.spyOn(nats.store, 'append');
  expect(await record(500, 499)).toBe('recorded');
  expectNoWholeReads(reads.calls);
  let rows = 0;
  for (const call of reads.calls) {
    if (call.subject === subject) rows += call.rows;
  }
  expect(rows).toBeLessThanOrEqual(3);
  expect(append).toHaveBeenCalledWith(expect.objectContaining({ historyChecked: true }));
}
it('records a warm report on a 500-event chat with at most three rows and no whole reads',
  warmReportReadsOnlyNewRows);

async function reportReplayMakesNoAppend() {
  await setup();
  const append = vi.spyOn(nats.store, 'append');
  expect(await record(1, 0)).toBe('recorded');
  expect(append).toHaveBeenCalledWith(expect.objectContaining({ historyChecked: true }));
  append.mockClear();
  expect(await record(1, 0)).toBe('duplicate');
  expect(append).not.toHaveBeenCalled();
  const rows = await chatHistory(nats.store, 'test', 'chat');
  expect(rows).toHaveLength(3);
}
it('checks report repeats before an append that opts into historyChecked', reportReplayMakesNoAppend);

async function refusesAClaimedSharedClassOnAPrivateSession() {
  await setup();
  const forged = {
    sequence: 1,
    previousSequence: 0,
    conversationId: 'chat',
    turnId: 'message',
    assistantId: 'assistant',
    requesterId: 'alice',
    threadId: 'private-thread',
    executionMode: 'restricted',
    sharingClass: 'shared_only',
    type: 'agent.turn_started',
  };
  await expect(recordReport(nats.store, keys, context, forged))
    .rejects.toThrow('Turn context class mismatch');
  const rows = await chatHistory(nats.store, 'test', 'chat');
  expect(rows).toHaveLength(2);
}
it('refuses a forged shared context class on a private session',
  refusesAClaimedSharedClassOnAPrivateSession);

async function seedAssistant() {
  await nats.seed([
    { ...event('assistant', 'assistant.created', {
      assistantId: 'assistant', ownerId: 'alice', kind: 'personal',
    }), subject: 'assistant-assistant' },
    { ...event('ready', 'computer.ready', {
      assistantId: 'assistant', computerId: 'computer', generation: 1,
    }), subject: 'computer-assistant' },
    { ...event('budget', 'budget.ceiling_set', {
      scope: 'global', dailyCeilingCents: 2000, ceilingCents: 20000,
      setBy: 'alice', defaultPayingGroupId: 'personal',
    }), subject: 'budget-test' },
  ]);
}
const start = { conversationId: 'chat', turnId: 'message', threadId: 'thread',
  status: 'started' as const };
async function turnReplayMakesNoAppend() {
  await setup();
  await seedAssistant();
  const append = vi.spyOn(nats.store, 'append');
  const first = await turnCommand(nats.store, context, start);
  const firstCommand = append.mock.calls[0]?.[0];
  append.mockClear();
  expect(await turnCommand(nats.store, context, { ...start, replay: true })).toEqual(first);
  expect(append).not.toHaveBeenCalled();
  expect(firstCommand).toMatchObject({ historyChecked: true });
  const rows: StoredEvent[] = [];
  for await (const row of nats.store.readStream('computer-assistant')) rows.push(row);
  function isStart(row: (typeof rows)[number]) {
    return row.event.type === 'computer.turn_started';
  }
  expect(rows.filter(isStart)).toHaveLength(1);
  await turnCommand(nats.store, context, { ...start, status: 'completed' });
  append.mockClear();
  expect(await turnCommand(nats.store, context, { ...start, status: 'completed' })).toBeUndefined();
  expect(append).not.toHaveBeenCalled();
}
it('checks turn repeats before an append that opts into historyChecked', turnReplayMakesNoAppend);

async function warmTurnReadsOnlyNewChatRows() {
  await setup();
  await seedAssistant();
  const events = [];
  for (let index = 0; index < 498; index++) {
    events.push(event(`lost-${index}`, 'agent.output_lost', {
      conversationId: 'chat', turnId: 'message',
    }));
  }
  await nats.seed(events);
  await record(1, 0);
  const reads = countReads(nats.store);
  await turnCommand(nats.store, context, start);
  await turnCommand(nats.store, context, { ...start, replay: true });
  await turnCommand(nats.store, context, { ...start, status: 'completed' });
  function isConversationRead(call: (typeof reads.calls)[number]) {
    return call.subject === subject;
  }
  const chatReads = reads.calls.filter(isConversationRead);
  expectNoWholeReads(chatReads);
  let rows = 0;
  for (const call of chatReads) rows += call.rows;
  expect(rows).toBeLessThanOrEqual(1);
}
it('starts, replays and closes a turn without rereading a warm 500-event chat',
  warmTurnReadsOnlyNewChatRows);

async function keepsReplayAndGapRules() {
  await setup();
  expect(await record(1, 0)).toBe('recorded');
  const append = vi.spyOn(nats.store, 'append');
  const lost = { ...report, sequence: 1, previousSequence: 0, type: 'agent.output_lost' };
  expect(await recordReport(nats.store, keys, context, lost)).toBe('duplicate');
  await expect(recordReport(nats.store, keys, context, {
    ...report, sequence: 1, previousSequence: 0, text: 'Changed',
  })).rejects.toThrow('Report sequence reused');
  await expect(record(2, 0)).rejects.toThrow('Report sequence gap');
  await expect(recordReport(nats.store, keys, context, {
    ...report, sequence: 2, previousSequence: 1, requesterId: 'bob',
  })).rejects.toThrow('Requester mismatch');
  expect(append).not.toHaveBeenCalled();
  expect(await recordReport(nats.store, keys, context, {
    ...report, sequence: 2,
  })).toBe('recorded');
}
it('keeps lost-output replay, reused-sequence, gap, requester and old-journal rules',
  keepsReplayAndGapRules);

async function picksUpPostsAndClosure() {
  await setup();
  await seedAssistant();
  await record(1, 0);
  await nats.seed([event('new-message', 'message.posted', {
    conversationId: 'chat', authorId: 'bob', authorKind: 'human', contentType: 'text',
    ...keys.encrypt('test', 'chat', 'New request'),
  })]);
  const next = { ...report, turnId: 'new-message', requesterId: 'bob',
    sequence: 2, previousSequence: 1 };
  expect(await recordReport(nats.store, keys, context, next)).toBe('recorded');
  await recordReport(nats.store, keys, context, {
    ...next, sequence: 3, previousSequence: 2, type: 'agent.turn_completed',
  });
  const nextStart = { ...start, turnId: 'new-message' };
  await expect(turnCommand(nats.store, context, nextStart)).rejects.toThrow('Turn is closed');
  expect(await turnCommand(nats.store, context, { ...nextStart, replay: true })).toBeUndefined();
}
it('picks up a user post between reports and refuses a start after its final report',
  picksUpPostsAndClosure);

async function refusesIncorrectReportReadBack(position: 'missing' | 'different') {
  await setup();
  const value = { ...report, sequence: 1, previousSequence: 0 };
  const append = nats.store.append.bind(nats.store);
  async function wrongPosition(command: AppendCommand) {
    const result = await append(command);
    if (result.status !== 'appended') return result;
    if (position === 'missing') return { ...result, sequence: result.sequence + 1 };
    const saved = await readEventAt(nats.store, subject, result.sequence, Infinity);
    if (!saved) throw new Error('Missing fixture report');
    const other = { ...saved.event, id: 'other-report', commandId: 'other-report' };
    await nats.seed([other]);
    return { ...result, sequence: await nats.store.head(subject) };
  }
  vi.spyOn(nats.store, 'append').mockImplementation(wrongPosition);
  await expect(recordReport(nats.store, keys, context, value)).rejects.toThrow(
    'Report sequence reused');
}
it.each(['missing', 'different'] as const)(
  'refuses a %s event at the report append position with the existing error',
  refusesIncorrectReportReadBack);

async function keepsConditionalAppend(operation: 'report' | 'turn') {
  await setup();
  await seedAssistant();
  const append = nats.store.append.bind(nats.store);
  async function writeAfterHistory(command: AppendCommand) {
    let concurrent = event('concurrent', 'agent.output_lost', {
      conversationId: 'chat', turnId: 'message',
    });
    if (operation === 'turn') {
      concurrent = { ...event('concurrent', 'computer.suspended', {
        assistantId: 'assistant', computerId: 'computer',
      }), subject: 'computer-assistant' };
    }
    await nats.seed([concurrent]);
    return append(command);
  }
  vi.spyOn(nats.store, 'append').mockImplementationOnce(writeAfterHistory);
  if (operation === 'report') {
    await expect(record(1, 0)).rejects.toThrow('Report append unavailable');
  } else {
    await expect(turnCommand(nats.store, context, start)).rejects.toThrow(
      'Turn append conflict or unavailable');
  }
}
it.each(['report', 'turn'] as const)(
  'keeps the conditional append when another writer changes the %s stream', keepsConditionalAppend);

async function keepsSecondComputerStarts() {
  await setup();
  await seedAssistant();
  const first = await turnCommand(nats.store, context, start);
  const secondContext = { ...context, computerId: 'second-computer' };
  const append = vi.spyOn(nats.store, 'append');
  expect(await turnCommand(nats.store, secondContext, start)).toEqual(first);
  expect(append).toHaveBeenCalledTimes(1);
  append.mockClear();
  expect(await turnCommand(nats.store, secondContext, { ...start, replay: true })).toEqual(first);
  expect(append).not.toHaveBeenCalled();
  const starts: StoredEvent[] = [];
  for await (const row of nats.store.readStream('computer-assistant')) {
    if (row.event.type === 'computer.turn_started') starts.push(row);
  }
  expect(starts).toHaveLength(2);
}
it('keeps a second computer start and checks that computer\'s own repeat', keepsSecondComputerStarts);
