import { expect, it } from 'vitest';
import type { EventEnvelope } from '@opencrane/events';
import { event as fixtureEvent } from '@opencrane/event-store/testing';
import { readChatFacts } from '../src/chat/chat-summary.ts';

const subject = 'conversation-chat';

async function boundsRetainedReportPositions() {
  const fromPositions: number[] = [];
  async function* readStream(_subject: string, from = 1) {
    fromPositions.push(from);
    await Promise.resolve();
    for (let index = 0; index < 30000; index++) {
      const storedReport = { computerId: 'computer', sequence: index + 1, digest: 'a'.repeat(64) };
      const data = { conversationId: 'chat', turnId: 'message' };
      const event: EventEnvelope = { ...fixtureEvent(`report-${index}`, subject, 'agent.output_lost'),
        data, report: storedReport };
      if (index + 1 >= from) yield { sequence: index + 1, event };
    }
  }
  const store = { readStream };
  const first = await readChatFacts(store, 'test', 'chat', 'message', 'computer', 1);
  const second = await readChatFacts(store, 'test', 'chat', 'message', 'computer', 1);
  expect(second).toEqual(first);
  expect(second.reportPosition).toBe(1);
  expect(second.lastReportSequence).toBe(30000);
  expect(fromPositions).toEqual([1, 1]);
}
it('bounds retained report positions and still finds the first saved report',
  boundsRetainedReportPositions);
