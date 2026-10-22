import { expect, it } from 'vitest';
import type { ChatRow } from '@opencrane/protocol';
import { transcript } from '../src/app/chat/chat-state.ts';

const row = (position: number, type: string, data: ChatRow['data']): ChatRow => ({ id: `event-${position}`, position, type, data, time: '2026-10-02T10:00:00Z' });
it('replays streamed text once, replaces completion and keeps the stopped partial across reload', () => {
  const rows = [row(1, 'message.posted', { text: 'Hello', authorId: 'me' }),
    row(2, 'agent.turn_started', { turnId: 'event-1' }),
    row(3, 'agent.message_delta', { turnId: 'event-1', messageId: 'reply', text: 'Hello ' }),
    row(4, 'agent.message_delta', { turnId: 'event-1', messageId: 'reply', text: 'back' })];
  expect(transcript([...rows, rows[3]!], 'me').at(-1)).toMatchObject({ text: 'Hello back', state: 'working' });
  const stopped = [...rows, row(5, 'agent.turn_stop_requested', { turnId: 'event-1' }),
    row(6, 'agent.message_completed', { turnId: 'event-1', messageId: 'reply', text: 'Hello back and more' }),
    row(7, 'agent.turn_failed', { turnId: 'event-1', reason: 'stop_interrupted' })];
  expect(transcript(stopped, 'me').at(-1)).toMatchObject({ text: 'Hello back', state: 'stopped' });
  expect(transcript([...rows, row(5, 'agent.message_completed', { turnId: 'event-1', messageId: 'reply', text: 'Final answer' }),
    row(6, 'agent.turn_completed', { turnId: 'event-1' })], 'me').at(-1)).toMatchObject({ text: 'Final answer', state: 'done' });
});
