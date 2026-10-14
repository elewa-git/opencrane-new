import { ConversationList, findConversation } from './conversations-data';

function row(id: string, mode: 'agent_session' | 'group' = 'agent_session') {
  const common = { conversationId: id, createdAt: '2026-10-14T00:00:00Z', title: id };
  if (mode === 'group') return { ...common, mode, participantIds: ['me', 'you'] };
  return { ...common, mode, createdBy: 'me', assistantId: 'assistant' };
}

function reply(rows: ReturnType<typeof row>[], nextCursor: string | null = null) {
  return new Response(JSON.stringify({ rows, nextCursor }));
}

function changedReply(): Response {
  return new Response('{"status":"list_changed"}', { status: 409 });
}

describe('server-backed conversations list', () => {
  afterEach(() => vi.restoreAllMocks());

  it('loads more with the same filters, deduplicates and blocks concurrent clicks', async () => {
    let finish!: (response: Response) => void;
    const pending = new Promise<Response>(resolve => { finish = resolve; });
    const fetcher = vi.fn().mockResolvedValueOnce(reply([row('first')], 'page-2'))
      .mockReturnValueOnce(pending);
    const list = new ConversationList(fetcher);
    await list.change('archived', 'quarterly');
    const loading = list.loadMore();
    await list.loadMore();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1]?.[0]).toContain('section=archived&q=quarterly&limit=20&cursor=page-2');
    expect(list.rows()).toHaveLength(1);
    expect(list.announcement()).toBe('Loading more conversations…');
    finish(reply([row('first'), row('second')]));
    await loading;
    expect(list.rows().map(item => item.conversationId)).toEqual(['first', 'second']);
    expect(list.empty()).toBe(false);
  });

  it('waits for the final page before showing an empty state and clears search', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(reply([], 'next'))
      .mockResolvedValueOnce(reply([])).mockResolvedValueOnce(reply([]));
    const list = new ConversationList(fetcher);
    await list.change('recent', 'missing');
    expect(list.empty()).toBe(false);
    await list.loadMore();
    expect(list.empty()).toBe(true);
    expect(list.noMatches()).toBe(true);
    await list.change('recent', '');
    expect(list.noMatches()).toBe(false);
  });

  it('reloads once after list_changed and keeps rows on temporary failures', async () => {
    const changed = new Response('{"status":"list_changed"}', { status: 409 });
    const fetcher = vi.fn().mockResolvedValueOnce(reply([row('old')], 'next'))
      .mockResolvedValueOnce(changed).mockResolvedValueOnce(reply([row('fresh')], 'next'))
      .mockResolvedValueOnce(new Response('{}', { status: 503 }))
      .mockRejectedValueOnce(new TypeError('offline'));
    const list = new ConversationList(fetcher);
    await list.change('recent', '');
    await list.loadMore();
    expect(list.rows().map(item => item.conversationId)).toEqual(['fresh']);
    expect(list.announcement()).toBe('Conversation list changed. Showing the latest results.');
    expect(fetcher).toHaveBeenCalledTimes(3);
    await list.loadMore();
    expect(list.rows()).toHaveLength(1);
    expect(list.error()).toBeTruthy();
    await list.loadMore();
    expect(list.rows()).toHaveLength(1);
  });

  it('stops after a second list change and offers Retry', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(reply([row('old')], 'next'))
      .mockResolvedValueOnce(changedReply()).mockResolvedValueOnce(changedReply());
    const list = new ConversationList(fetcher);

    await list.change('recent', '');
    await list.loadMore();

    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls[2]?.[0]).not.toContain('cursor=');
    expect(list.rows()).toEqual([]);
    expect(list.error()).toContain('Try again');
    expect(list.denied()).toBe(false);
  });

  it.each([401, 403])('clears protected rows before reading a stalled %i body', async status => {
    const stalled = new Response('{}', { status });
    const readBody = vi.spyOn(stalled, 'json').mockImplementation(
      () => new Promise<unknown>(() => {}),
    );
    const fetcher = vi.fn().mockResolvedValueOnce(reply([row('private')], 'next'))
      .mockResolvedValueOnce(stalled);
    const list = new ConversationList(fetcher);
    await list.change('recent', '');

    const loading = list.loadMore();
    await vi.waitFor(() => expect(list.denied()).toBe(true));
    await loading;

    expect(list.rows()).toEqual([]);
    expect(list.cursor()).toBeUndefined();
    expect(readBody).not.toHaveBeenCalled();
  });

  it('clears denied rows and ignores late section and query replies', async () => {
    let finish!: (response: Response) => void;
    const pending = new Promise<Response>(resolve => { finish = resolve; });
    const fetcher = vi.fn().mockReturnValueOnce(pending)
      .mockResolvedValueOnce(reply([row('current')]))
      .mockResolvedValueOnce(new Response('{}', { status: 403 }));
    const list = new ConversationList(fetcher);
    const old = list.change('recent', 'old');
    await list.change('archived', 'new');
    finish(reply([row('stale')]));
    await old;
    expect(list.rows().map(item => item.conversationId)).toEqual(['current']);
    await list.change('recent', '');
    expect(list.rows()).toEqual([]);
    expect(list.denied()).toBe(true);
  });

  it('limits search to 100 characters and resets its cursor', async () => {
    const fetcher = vi.fn().mockResolvedValue(reply([], 'next'));
    const list = new ConversationList(fetcher);
    await list.change('recent', '');
    await list.change('recent', 'x'.repeat(120));
    expect(list.query()).toHaveLength(100);
    expect(fetcher.mock.calls[1]?.[0]).not.toContain('cursor=');
  });
});

describe('resume lookup', () => {
  afterEach(() => vi.restoreAllMocks());

  it('finds a team session on page two and a group in archived', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(reply([row('other')], 'next'))
      .mockResolvedValueOnce(reply([row('team')]))
      .mockResolvedValueOnce(reply([]))
      .mockResolvedValueOnce(reply([row('group', 'group')]));
    const team = await findConversation('team', fetcher);
    const group = await findConversation('group', fetcher);
    expect(team?.conversationId).toBe('team');
    expect(group?.mode).toBe('group');
    expect(fetcher.mock.calls[1]?.[0]).toContain('cursor=next');
    expect(fetcher.mock.calls[3]?.[0]).toContain('section=archived');
  });

  it('stops after five pages in each section and treats outages as retryable', async () => {
    const fetcher = vi.fn().mockImplementation(() =>
      Promise.resolve(reply([row('other')], 'next')));
    expect(await findConversation('missing', fetcher)).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(10);
    fetcher.mockReset().mockResolvedValue(new Response('{}', { status: 503 }));
    await expect(findConversation('missing', fetcher)).rejects.toThrow();
  });

  it('restarts at Recent page one after one list change and finds the saved chat', async () => {
    const changed = new Response('{"status":"list_changed"}', { status: 409 });
    const fetcher = vi.fn().mockResolvedValueOnce(reply([row('other')], 'old-cursor'))
      .mockResolvedValueOnce(changed)
      .mockResolvedValueOnce(reply([row('saved')]));

    const found = await findConversation('saved', fetcher);

    expect(found?.conversationId).toBe('saved');
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls[2]?.[0]).toContain('section=recent');
    expect(fetcher.mock.calls[2]?.[0]).not.toContain('cursor=');
  });

  it('stops after a second lookup list change and keeps the failure retryable', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(changedReply())
      .mockResolvedValueOnce(changedReply());

    await expect(findConversation('saved', fetcher)).rejects.toThrow('list_changed');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
