import { expect, it, vi } from 'vitest';
import type { ChatConversation } from '@opencrane/protocol';
import { DirectChatArchive } from './direct-chat-archive';

const recent = {
  conversationId: 'chat', mode: 'group', participantIds: ['me', 'other'],
  createdBy: 'me', createdAt: '2026-10-14T00:00:00Z',
  joinEventId: 'join-one', archived: false, archivePosition: 0,
} satisfies ChatConversation;
const archived = { ...recent, archived: true, archivePosition: 12 };

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function fixture() {
  const requests: { url: string; method: string; body?: Record<string, unknown> }[] = [];
  let postReply = response({ status: 'appended', sequence: 12 });
  let statusReply = response({ status: 'appended', conversationId: 'chat', commandId: 'archive-id',
    type: 'conversation.archived', sequence: 12,
    projection: { content: 'current', iam: 'current' } });
  let row: ChatConversation = archived;
  const reload = vi.fn(async () => row);
  const accessChanged = vi.fn();
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    requests.push({ url, method, body });
    return method === 'POST' ? postReply : statusReply;
  });
  const archive = new DirectChatArchive(() => 'chat', () => true, reload, accessChanged, fetcher);
  archive.setRow(recent);
  return {
    archive, requests, reload, accessChanged,
    setPost(reply: Response) { postReply = reply; },
    setStatus(reply: Response) { statusReply = reply; },
    setRow(value: ChatConversation) { row = value; },
  };
}

it('sends one archive command with the saved row fields and waits for current', async () => {
  const test = fixture();
  test.setStatus(response({ status: 'appended', conversationId: 'chat', commandId: 'archive-id',
    type: 'conversation.archived', sequence: 12,
    projection: { content: 'applying', iam: 'current' } }));
  await test.archive.change();
  await test.archive.change();
  expect(test.requests.filter(request => request.method === 'POST')).toHaveLength(1);
  const body = test.requests[0]?.body;
  expect(body).toMatchObject({ action: 'archive', archived: true, joinEventId: 'join-one',
    expectedArchivePosition: 0 });
  expect(body?.['id']).toEqual(expect.any(String));
  expect(test.archive.row()?.archived).toBe(false);
  expect(test.archive.notice()).toBe('Saved. Your list is still updating.');
  await test.archive.checkStatus();
  expect(test.requests.filter(request => request.method === 'POST')).toHaveLength(1);
  test.setStatus(response({ status: 'appended', conversationId: 'chat', commandId: String(body?.['id']),
    type: 'conversation.archived', sequence: 12,
    projection: { content: 'current', iam: 'current' } }));
  await test.archive.checkStatus();
  expect(test.reload).toHaveBeenCalledOnce();
  expect(test.archive.row()?.archived).toBe(true);
  expect(test.archive.notice()).toBe('You archived this conversation. Only your list changed.');
});

it('keeps one command after a lost reply, checks status, and retries only after 404', async () => {
  const test = fixture();
  test.setPost(response({}, 503));
  await test.archive.change();
  const firstBody = test.requests[0]?.body;
  expect(test.archive.notice()).toContain('reply');
  test.setStatus(response({}, 404));
  await test.archive.checkStatus();
  expect(test.archive.notice()).toBe('No record of this change yet.');
  test.setPost(response({ status: 'appended', sequence: 12 }));
  await test.archive.retry();
  expect(test.requests.filter(request => request.method === 'POST').map(request => request.body))
    .toEqual([firstBody, firstBody]);
});

it('refreshes after conflict, clears invalid commands and loses protected state on denial', async () => {
  const test = fixture();
  test.setPost(response({ status: 'refused' }, 409));
  await test.archive.change();
  expect(test.reload).toHaveBeenCalledOnce();
  expect(test.archive.notice()).toContain('another device');
  expect(test.archive.row()?.archived).toBe(true);
  test.archive.setRow(recent);
  test.setPost(response({}, 400));
  await test.archive.change();
  expect(test.archive.commandId()).toBe('');
  test.setPost(response({}, 403));
  await test.archive.change();
  expect(test.accessChanged).toHaveBeenCalledOnce();
  expect(test.archive.row()).toBeUndefined();
});

it('ignores an older reply after the selected chat changes', async () => {
  const test = fixture();
  let finish: ((reply: Response) => void) | undefined;
  const pending = new Promise<Response>(resolve => { finish = resolve; });
  test.setPost(response({}, 503));
  const fetcher = vi.fn(() => pending);
  const archive = new DirectChatArchive(() => 'other', () => true,
    test.reload, test.accessChanged, fetcher);
  archive.setRow({ ...recent, conversationId: 'other' });
  const change = archive.change();
  archive.setRow({ ...recent, conversationId: 'new' });
  finish?.(response({ status: 'appended', sequence: 12 }));
  await change;
  expect(archive.row()?.conversationId).toBe('new');
  expect(test.reload).not.toHaveBeenCalled();
});
