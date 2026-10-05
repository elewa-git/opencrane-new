import type { StoredEvent } from '@opencrane/event-store';
import { envelope } from '@opencrane/models';
import { expect, it } from 'vitest';
import { privateContext, PRIVATE_CONTEXT_LIMIT_BYTES } from '../src/chat/private-context.ts';

function row(sequence: number, type: string, data: Record<string, unknown>, id = `row-${sequence}`) {
  const event = envelope('test', 'conversation-private', 'agent.turn_completed',
    { conversationId: 'private', turnId: 'test' }, id);
  event.type = type;
  event.data = data;
  event.time = `2026-10-05T00:00:${String(sequence % 60).padStart(2, '0')}Z`;
  return { sequence, event } satisfies StoredEvent;
}
function message(sequence: number, text: string, authorId = 'alice') {
  return row(sequence, 'message.posted', { authorKind: 'human', authorId, text });
}
function decrypt(data: unknown) {
  if (!data || typeof data !== 'object' || !('text' in data) || typeof data.text !== 'string') {
    throw new Error('Unexpected decryption');
  }
  return data.text;
}
function reply(sequence: number, turnId: string, text: string) {
  return row(sequence, 'agent.message_completed', { turnId, text });
}
function finish(sequence: number, turnId: string, type = 'agent.turn_completed') {
  return row(sequence, type, { turnId });
}

it('keeps only the requester’s messages and completed replies in row order', () => {
  const first = message(1, 'member-canary');
  const rows = [first, message(2, 'bob-canary', 'bob'), reply(3, first.event.id, 'reply-one'),
    reply(4, first.event.id, 'reply-two'), finish(5, first.event.id)];
  const ignored = ['agent.message_delta', 'agent.reasoning_summarised', 'agent.command_ran',
    'file.uploaded', 'file.delivered', 'approval.decided', 'decision.recorded'];
  for (const [index, type] of ignored.entries()) {
    rows.push(row(index + 6, type, { turnId: first.event.id, text: `${type}-canary` }));
  }
  function decryptAllowed(data: unknown) {
    const text = decrypt(data);
    expect(['member-canary', 'reply-one', 'reply-two']).toContain(text);
    return text;
  }
  const result = privateContext(rows, message(20, 'current-canary'), 'alice', decryptAllowed);
  expect(result).toEqual({ exchanges: [{ at: first.event.time, member: 'member-canary',
    assistant: ['reply-one', 'reply-two'] }], omittedExchanges: 0 });
  expect(JSON.stringify(result)).not.toContain('bob-canary');
  for (const type of ignored) expect(JSON.stringify(result)).not.toContain(`${type}-canary`);
});

it('keeps no request text for failed, stopped, unfinished or lost-output turns', () => {
  const rows: StoredEvent[] = [];
  for (const [index, type] of ['agent.turn_failed', 'agent.turn_stop_requested',
    'unfinished', 'agent.output_lost'].entries()) {
    const request = message(index * 4 + 1, `secret-${type}`);
    rows.push(request, reply(index * 4 + 2, request.event.id, `reply-${type}`));
    if (type !== 'unfinished') rows.push(finish(index * 4 + 3, request.event.id, type));
    if (type === 'agent.output_lost') rows.push(finish(index * 4 + 4, request.event.id));
  }
  const result = privateContext(rows, message(30, 'now'), 'alice', decrypt);
  expect(result?.exchanges).toHaveLength(4);
  for (const exchange of result!.exchanges) expect(exchange).toMatchObject({ outcome: 'not_completed' });
  expect(JSON.stringify(result)).not.toMatch(/secret-|reply-/u);
});

it('uses earlier messages even when their replies finish after the current message', () => {
  const first = message(1, 'earlier');
  const current = message(2, 'current');
  const rows = [first, current, reply(3, first.event.id, 'late-reply'),
    finish(4, first.event.id), reply(5, current.event.id, 'current-reply'),
    finish(6, current.event.id), message(7, 'future')];
  expect(privateContext(rows, current, 'alice', decrypt)).toEqual({ exchanges: [
    { at: first.event.time, member: 'earlier', assistant: ['late-reply'] },
  ], omittedExchanges: 0 });
});

it('takes newest whole exchanges and counts older exchanges omitted at the byte limit', () => {
  const rows: StoredEvent[] = [];
  for (let index = 0; index < 4; index++) {
    const request = message(index * 3 + 1, `member-${index}`);
    rows.push(request, reply(index * 3 + 2, request.event.id, '界'.repeat(3000)),
      finish(index * 3 + 3, request.event.id));
  }
  const result = privateContext(rows, message(20, 'now'), 'alice', decrypt);
  expect(result?.omittedExchanges).toBe(2);
  expect(result?.exchanges).toHaveLength(2);
  expect(result?.exchanges[0]).toMatchObject({ member: 'member-2', assistant: ['界'.repeat(3000)] });
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(PRIVATE_CONTEXT_LIMIT_BYTES);
});

it('omits an oversized newest exchange without taking smaller older exchanges', () => {
  const small = message(1, 'small');
  const big = message(4, 'huge');
  const rows = [small, reply(2, small.event.id, 'small-reply'), finish(3, small.event.id),
    big, reply(5, big.event.id, 'é'.repeat(24 * 1024)), finish(6, big.event.id)];
  expect(privateContext(rows, message(8, 'now'), 'alice', decrypt)).toEqual({
    exchanges: [], omittedExchanges: 2,
  });
});

it('returns no context when there are no earlier exchanges', () => {
  const current = message(1, 'now');
  expect(privateContext([current, message(2, 'future')], current, 'alice', decrypt)).toBeUndefined();
});
