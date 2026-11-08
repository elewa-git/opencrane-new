import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ChatConversation } from '@opencrane/protocol';
import { CloseReview, closedByName } from './close-review';

const chat = {
  conversationId: 'parent', mode: 'group', participantIds: ['me', 'other'],
  createdBy: 'me', createdAt: '2026-10-14T00:00:00Z', canClose: true,
  status: 'open', title: 'A long group title',
} satisfies ChatConversation;

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

function fixture() {
  let post = reply(200, { status: 'appended', sequence: 4 });
  let status = reply(200, { status: 'appended', conversationId: 'parent',
    commandId: 'close-id', type: 'conversation.closed', sequence: 4,
    projection: { content: 'applying', iam: 'current' } });
  const requests: { method: string; url: string; body?: unknown }[] = [];
  function fetcher(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = typeof input === 'string' ? input
      : input instanceof Request ? input.url : input.href;
    const method = init?.method ?? 'GET';
    const body: unknown = typeof init?.body === 'string'
      ? JSON.parse(init.body) as unknown : undefined;
    requests.push({ method, url, body });
    return Promise.resolve(method === 'POST' ? post : status);
  }
  const refresh = vi.fn(() => Promise.resolve(chat));
  const denied = vi.fn();
  const review = new CloseReview(refresh, denied, fetcher);
  return { review, requests, refresh, denied,
    setPost(value: Response) { post = value; },
    setStatus(value: Response) { status = value; } };
}

afterEach(() => sessionStorage.clear());

it('hides close unless the server row permits it and never sends on cancel', () => {
  const test = fixture();
  expect(test.review.open({ ...chat, canClose: false })).toBe(false);
  expect(test.review.open({ ...chat, status: 'closed' })).toBe(false);
  expect(test.review.open(chat)).toBe(true);
  test.review.cancel();
  expect(test.requests).toHaveLength(0);
});

it('sends one close and checks the original id after a lost acknowledgement', async () => {
  const test = fixture();
  test.setPost(reply(503, {}));
  test.review.open(chat);
  await Promise.all([test.review.confirm(), test.review.confirm()]);
  expect(test.requests.filter(request => request.method === 'POST')).toHaveLength(1);
  const body = z.object({ id: z.string() }).parse(test.requests[0]?.body);
  expect(body.id.length).toBeGreaterThan(0);
  expect(test.review.pendingId()).toBe(body.id);
  test.setStatus(reply(200, { status: 'appended', conversationId: 'parent',
    commandId: body.id, type: 'conversation.closed', sequence: 4,
    projection: { content: 'applying', iam: 'current' } }));
  await test.review.checkStatus();
  expect(test.requests.at(-1)?.url).toContain(`/changes/${body.id}`);
  expect(test.requests.filter(request => request.method === 'POST')).toHaveLength(1);
});

it('refreshes authoritative facts on conflict and clears pending on denial', async () => {
  const test = fixture();
  test.setPost(reply(409, {}));
  test.review.open(chat);
  await test.review.confirm();
  expect(test.refresh).toHaveBeenCalledOnce();
  test.setPost(reply(403, {}));
  test.review.open(chat);
  await test.review.confirm();
  expect(test.denied).toHaveBeenCalledOnce();
  expect(test.review.pendingId()).toBe('');
});

it('does not infer that closing a parent closes its child', () => {
  const test = fixture();
  const child = { ...chat, conversationId: 'child', mode: 'agent_session' as const,
    assistantId: 'assistant', status: 'open' as const };
  const parentClose = [{ id: 'close-parent', position: 4,
    type: 'conversation.closed', time: '2026-10-14T10:00:00Z',
    data: { closedBy: 'me', conversationId: 'parent' } }];
  const childClose = [{ id: 'close-child', position: 5,
    type: 'conversation.closed', time: '2026-10-14T11:00:00Z',
    data: { closedBy: 'me', conversationId: 'child' } }];
  expect(test.review.isClosed(chat, parentClose)).toBe(true);
  expect(test.review.isClosed(child, parentClose)).toBe(false);
  expect(test.review.isClosed(child, childClose)).toBe(true);
  expect(test.review.isClosed(chat, childClose)).toBe(false);
});

it('shows a known closer by name and ignores an old reply after access loss', async () => {
  expect(closedByName('other', 'me', [{ memberId: 'other', displayName: 'Grace' }]))
    .toBe('Grace');
  expect(closedByName('missing-member', 'me', [])).toBe('a participant');
  expect(closedByName('other', 'me', [{ memberId: 'other', displayName: null }]))
    .toBe('a participant');
  let finish!: (response: Response) => void;
  function saveFinish(resolve: (response: Response) => void): void { finish = resolve; }
  const held = new Promise<Response>(saveFinish);
  function heldFetch(): Promise<Response> { return held; }
  const denied = vi.fn();
  const review = new CloseReview(() => Promise.resolve(chat), denied, heldFetch);
  review.open(chat);
  const closing = review.confirm();
  review.clear();
  finish(reply(200, { status: 'appended', sequence: 4 }));
  await closing;
  expect(review.pendingId()).toBe('');
  expect(review.isClosed(chat, [])).toBe(false);
  expect(denied).not.toHaveBeenCalled();
});
