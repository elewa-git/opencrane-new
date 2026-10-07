import { expect, it } from 'vitest';
import { dirname } from 'node:path';
import { parseEventByType, type EventEnvelope } from '@opencrane/events';
import type { AppendCommand, StoredEvent } from '@opencrane/event-store';
import { event as fixtureEvent, natsFixture } from '@opencrane/event-store/testing';
import { readChatFacts } from '../src/chat/chat-summary.ts';
import { conversationKeys } from '../src/chat/keys.ts';
import { recordReport } from '../src/chat/reports.ts';

const subject = 'conversation-chat';

async function keepsLongRepliesWarm() {
  const reportCount = 600 * 300;
  const fromPositions: number[] = [];
  async function* readStream(_subject: string, from = 1) {
    fromPositions.push(from);
    await Promise.resolve();
    for (let index = from - 1; index < reportCount; index++) {
      const storedReport = { computerId: 'computer', sequence: index + 1, digest: 'a'.repeat(64) };
      const data = { conversationId: 'chat', turnId: 'message' };
      const event: EventEnvelope = { ...fixtureEvent(`report-${index}`, subject, 'agent.message_delta'),
        data, report: storedReport };
      if (index + 1 >= from) yield { sequence: index + 1, event };
    }
  }
  const store = { readStream };
  const first = await readChatFacts(store, 'test', 'chat', 'message', 'computer', 1);
  const second = await readChatFacts(store, 'test', 'chat', 'message', 'computer', 1);
  expect(second).toEqual(first);
  expect(second.reportPosition).toBe(1);
  expect(second.lastReportSequence).toBe(reportCount);
  expect(fromPositions).toEqual([1, 180001]);
}
it('keeps 600 long replies warm and still finds the first saved report', keepsLongRepliesWarm);

async function recordsAfterLongRepliesUsingOnlyTheTail() {
  const nats = await natsFixture();
  const fromPositions: number[] = [];
  let saved: StoredEvent | undefined;
  async function* readStream(_subject: string, from = 1) {
    fromPositions.push(from);
    await Promise.resolve();
    const created = { ...fixtureEvent('created', subject, 'conversation.created'),
      data: { conversationId: 'chat', assistantId: 'assistant', createdBy: 'alice',
        mode: 'agent_session' } };
    const message = { ...fixtureEvent('message', subject, 'message.posted'),
      data: { conversationId: 'chat', authorId: 'alice', executionMode: 'restricted' } };
    if (from <= 1) yield { sequence: 1, event: created };
    if (from <= 2) yield { sequence: 2, event: message };
    for (let sequence = Math.max(3, from); sequence <= 180002; sequence++) {
      const report = { computerId: 'computer', sequence: sequence - 2, digest: 'a'.repeat(64) };
      const event = { ...fixtureEvent(`chunk-${sequence}`, subject, 'agent.message_delta'),
        report, data: { conversationId: 'chat', turnId: 'message' } };
      yield { sequence, event };
    }
    if (saved && saved.sequence >= from) yield saved;
  }
  function append(command: AppendCommand) {
    expect(command.expectedSequence).toBe(180002);
    expect(command.historyChecked).toBe(true);
    const parsed = parseEventByType(command.event);
    if (!parsed.success) throw new Error('Invalid fixture append');
    saved = { sequence: 180003, event: parsed.event };
    const result = { status: 'appended' as const, sequence: saved.sequence };
    return Promise.resolve(result);
  }
  const store = nats.store;
  store.readStream = readStream;
  store.append = append;
  try {
    const keys = conversationKeys(`${dirname(nats.env().NATS_CA_FILE)}/keys`);
    keys.provision('test', 'chat');
    await readChatFacts(store, 'test', 'chat', 'message');
    fromPositions.length = 0;
    const context = { silo: 'test', computerId: 'computer', assistantId: 'assistant' };
    const report = { conversationId: 'chat', turnId: 'message', assistantId: 'assistant',
      requesterId: 'alice', sequence: 180001, previousSequence: 180000,
      type: 'agent.message_delta', messageId: 'reply', text: 'Next chunk' };
    expect(await recordReport(store, keys, context, report)).toBe('recorded');
    expect(fromPositions).toEqual([180003, 180003]);
    expect(await recordReport(store, keys, context, report)).toBe('duplicate');
    expect(fromPositions).toEqual([180003, 180003, 180003, 180003]);
  } finally {
    await nats.close();
  }
}
it('records and repeats a report after 600 long replies using only tail reads',
  recordsAfterLongRepliesUsingOnlyTheTail);

async function rebuildsOversizedReportPositions() {
  const fromPositions: number[] = [];
  async function* readStream(_subject: string, from = 1) {
    fromPositions.push(from);
    await Promise.resolve();
    for (let sequence = from; sequence <= 600000; sequence++) {
      const report = { computerId: 'computer', sequence, digest: 'a'.repeat(64) };
      const event = { ...fixtureEvent(`report-${sequence}`, subject, 'agent.output_lost'),
        report, data: { conversationId: 'chat', turnId: 'message' } };
      yield { sequence, event };
    }
  }
  const store = { readStream };
  const first = await readChatFacts(store, 'test', 'chat', 'message', 'computer', 1);
  const second = await readChatFacts(store, 'test', 'chat', 'message', 'computer', 1);
  expect(second).toEqual(first);
  expect(second.reportPosition).toBe(1);
  expect(second.lastReportSequence).toBe(600000);
  expect(fromPositions).toEqual([1, 1]);
}
it('rebuilds oversized report positions without forgetting the first saved report',
  rebuildsOversizedReportPositions);
