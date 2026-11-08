import { afterEach, expect, it, vi } from 'vitest';
import type { ChatConversation } from '@opencrane/protocol';
import { CloseReview } from './close-review';

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
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) as unknown : undefined;
    requests.push({ method, url, body });
    return Promise.resolve(method === 'POST' ? post : status);
  }
  const refresh = vi.fn(async () => chat);
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
  const body = test.requests[0]?.body;
  expect(body).toMatchObject({ id: expect.any(String) });
  expect(test.review.pendingId()).toBe((body as { id: string }).id);
  test.setStatus(reply(200, { status: 'appended', conversationId: 'parent',
    commandId: (body as { id: string }).id, type: 'conversation.closed', sequence: 4,
    projection: { content: 'applying', iam: 'current' } }));
  await test.review.checkStatus();
  expect(test.requests.at(-1)?.url).toContain(`/changes/${(body as { id: string }).id}`);
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
  expect(test.review.isClosed(chat, [{ id: 'close-parent', position: 4,
    type: 'conversation.closed', time: '2026-10-14T10:00:00Z',
    data: { closedBy: 'me', conversationId: 'parent' } }])).toBe(true);
  expect(test.review.isClosed(child, [])).toBe(false);
});
