import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ChatConversation, ChatRow } from '@opencrane/protocol';
import { ReadMarker } from './read-marker';

const row = {
  conversationId: 'chat', mode: 'group', participantIds: ['me', 'other'],
  createdBy: 'me', createdAt: '2026-10-14T00:00:00Z',
  joinEventId: 'join-one', archived: false, archivePosition: 0,
  throughPosition: 0,
} satisfies ChatConversation;

function message(position: number, type = 'message.posted'): ChatRow {
  return { id: `event-${position}`, position, type,
    time: '2026-10-14T00:00:00Z', data: { text: 'Hello' } };
}

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function fixture() {
  let selected = 'chat';
  let postReply: Response | Error = reply({ status: 'appended', sequence: 12 });
  let statusReply = reply({ status: 'appended', conversationId: 'chat',
    commandId: 'read-id', type: 'conversation.read_advanced', sequence: 12,
    projection: { content: 'current', iam: 'current' } });
  const requests: { method: string; body?: string }[] = [];
  function fetcher(_input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    requests.push({ method: init?.method ?? 'GET',
      ...(typeof init?.body === 'string' ? { body: init.body } : {}) });
    if (init?.method === 'POST') {
      if (postReply instanceof Error) return Promise.reject(postReply);
      return Promise.resolve(postReply);
    }
    return Promise.resolve(statusReply);
  }
  const reload = vi.fn(() => Promise.resolve(row));
  const accessChanged = vi.fn();
  const marker = new ReadMarker(() => selected, () => true, reload, accessChanged,
    fetcher);
  marker.setRow(row);
  return { marker, requests, reload, accessChanged,
    select(value: string) { selected = value; },
    post(value: Response | Error) { postReply = value; },
    status(value: Response) { statusReply = value; } };
}

it('marks only the newest rendered message after catch-up, visibility and scroll checks', async () => {
  const test = fixture();
  await test.marker.rendered([message(1)], false, true, true);
  await test.marker.rendered([message(1), message(2)], false, true, true);
  await test.marker.rendered([message(1), message(2), message(3)], true, false, true);
  await test.marker.rendered([message(1), message(2), message(3)], true, true, false);
  expect(test.requests).toHaveLength(0);
  await test.marker.rendered([message(1), message(2), message(3)], true, true, true);
  expect(JSON.parse(test.requests[0]?.body ?? '{}')).toMatchObject({
    action: 'read', joinEventId: 'join-one', throughPosition: 3, throughEventId: 'event-3',
  });
  expect(test.requests).toHaveLength(1);
  await test.marker.rendered([message(4, 'decision.recorded'), message(0)], true, true, true);
  expect(test.requests).toHaveLength(1);
});

it('keeps the highest saved or confirmed position for each join', async () => {
  const test = fixture();
  test.marker.setRow({ ...row, throughPosition: 8 });
  await test.marker.rendered([message(7)], true, true, true);
  expect(test.requests).toHaveLength(0);
  await test.marker.rendered([message(9)], true, true, true);
  test.marker.setRow({ ...row, throughPosition: 2 });
  await test.marker.rendered([message(8)], true, true, true);
  expect(test.requests).toHaveLength(1);
  test.marker.setRow({ ...row, joinEventId: 'join-two', throughPosition: 0 });
  await test.marker.rendered([message(3)], true, true, true);
  expect(test.requests).toHaveLength(2);
});

it('waits for a server row with a saved position', async () => {
  const test = fixture();
  test.marker.setRow(undefined);
  await test.marker.rendered([message(3)], true, true, true);
  test.marker.setRow({ ...row, throughPosition: undefined });
  await test.marker.rendered([message(3)], true, true, true);
  expect(test.requests).toHaveLength(0);
});

it('keeps one command during an uncertain reply and checks status before another POST', async () => {
  const test = fixture();
  test.post(reply({}, 503));
  await test.marker.rendered([message(3)], true, true, true);
  const original = test.requests[0]?.body;
  test.status(reply({}, 404));
  test.post(reply({ status: 'appended', sequence: 3 }));
  await test.marker.rendered([message(4)], true, true, true);
  expect(test.requests.map(request => request.method)).toEqual(['POST', 'GET', 'POST', 'POST']);
  expect(test.requests[2]?.body).toBe(original);
  expect(test.requests[3]?.body).not.toBe(original);
});

it('drops conflicts, clears on refusal and ignores a late reply after switching chats', async () => {
  const test = fixture();
  test.post(reply({}, 409));
  await test.marker.rendered([message(3)], true, true, true);
  expect(test.reload).toHaveBeenCalledOnce();
  test.select('other');
  test.marker.clear();
  await test.marker.rendered([message(4)], true, true, true);
  expect(test.requests).toHaveLength(1);
  test.select('chat');
  test.marker.setRow(row);
  test.post(reply({}, 403));
  await test.marker.rendered([message(5)], true, true, true);
  expect(test.accessChanged).toHaveBeenCalledOnce();
});

it('sends one later command when a newer row appears during the first POST', async () => {
  let finish: ((reply: Response) => void) | undefined;
  const held = new Promise<Response>(resolve => { finish = resolve; });
  const bodies: string[] = [];
  function fetcher(_input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    if (typeof init?.body === 'string') bodies.push(init.body);
    if (bodies.length === 1) return held;
    return Promise.resolve(reply({ status: 'appended', sequence: 4 }));
  }
  const marker = new ReadMarker(() => 'chat', () => true, () => Promise.resolve(row),
    vi.fn(), fetcher);
  marker.setRow(row);
  const first = marker.rendered([message(3)], true, true, true);
  await marker.rendered([message(4)], true, true, true);
  expect(bodies).toHaveLength(1);
  finish?.(reply({ status: 'appended', sequence: 3 }));
  await first;
  expect(bodies).toHaveLength(2);
  expect(JSON.parse(bodies[1] ?? '{}')).toMatchObject({ throughPosition: 4 });
});

it.each([0, 425, 503])('checks the original id after an uncertain %s', async status => {
  const test = fixture();
  if (status === 0) test.post(new TypeError('Network lost'));
  else test.post(reply({}, status));
  await test.marker.rendered([message(3)], true, true, true);
  const original = z.object({ id: z.string() }).parse(JSON.parse(test.requests[0]?.body ?? '{}'));
  test.status(reply({ status: 'appended', conversationId: 'chat', commandId: original.id,
    type: 'conversation.read_advanced', sequence: 3,
    projection: { content: 'current', iam: 'current' } }));
  await test.marker.rendered([message(3)], true, true, true);
  expect(test.requests.map(request => request.method)).toEqual(['POST', 'GET']);
});

it('aborts an in-flight read when the selected chat changes', async () => {
  let finish: ((reply: Response) => void) | undefined;
  let aborted = false;
  const held = new Promise<Response>(resolve => { finish = resolve; });
  function fetcher(_input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    init?.signal?.addEventListener('abort', () => { aborted = true; });
    return held;
  }
  let selected = 'chat';
  const marker = new ReadMarker(() => selected, () => true, () => Promise.resolve(row),
    vi.fn(), fetcher);
  marker.setRow(row);
  const first = marker.rendered([message(3)], true, true, true);
  selected = 'other';
  marker.clear();
  finish?.(reply({ status: 'appended', sequence: 3 }));
  await first;
  expect(aborted).toBe(true);
  marker.setRow({ ...row, conversationId: 'other' });
  await marker.rendered([message(2)], true, true, true);
  expect(marker).toBeDefined();
});

it('clears after a refused change check without sending again', async () => {
  const test = fixture();
  test.post(reply({}, 425));
  await test.marker.rendered([message(3)], true, true, true);
  test.status(reply({}, 403));
  await test.marker.rendered([message(4)], true, true, true);
  expect(test.requests.map(request => request.method)).toEqual(['POST', 'GET']);
  expect(test.accessChanged).toHaveBeenCalledOnce();
});

it('drops an invalid read id without checking its status', async () => {
  const test = fixture();
  test.post(reply({}, 400));
  await test.marker.rendered([message(3)], true, true, true);
  const firstBody = test.requests[0]?.body;
  await test.marker.rendered([message(4)], true, true, true);
  expect(test.requests.map(request => request.method)).toEqual(['POST', 'POST']);
  expect(test.requests[1]?.body).not.toBe(firstBody);
});
