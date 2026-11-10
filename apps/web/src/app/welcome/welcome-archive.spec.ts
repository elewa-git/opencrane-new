import { WelcomeArchive } from './welcome-archive';
import { z } from 'zod';

const welcome = { kind: 'welcome', welcomeId: 'saved-welcome', route: '/welcome',
  title: 'Welcome', createdAt: '2026-10-14T09:02:00.000Z',
  activityAt: '2026-10-14T09:03:00.000Z', unread: 0,
  archived: false, archivePosition: 0 };

function list(rows: unknown[]): Response {
  return new Response(JSON.stringify({ rows, nextCursor: null }));
}

function receipt(commandId: string, position: number): Response {
  return new Response(JSON.stringify({ status: 'confirmed', commandId, position,
    operation: 'onboarding.welcome_archive_set' }));
}

function archiveBody(init?: RequestInit) {
  if (typeof init?.body !== 'string') throw new Error('Missing archive body');
  const body: unknown = JSON.parse(init.body);
  return z.object({ commandId: z.string(), welcomeId: z.string(),
    archived: z.boolean(), expectedArchivePosition: z.number().int() }).parse(body);
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

describe('completed welcome archive choice', () => {
  it('uses the saved welcome id, checks a lost reply and restores without reopening', async () => {
    let posted: Record<string, unknown> | null = null;
    let archived = false;
    let firstReplyLost = true;
    let archivePosts = 0;
    const fetcher: typeof fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url === '/api/onboarding/welcome/archive') {
        archivePosts += 1;
        posted = archiveBody(init);
        if (firstReplyLost) {
          firstReplyLost = false;
          archived = true;
          return Promise.reject(new TypeError('reply lost'));
        }
        archived = Boolean(posted['archived']);
        return Promise.resolve(receipt(String(posted['commandId']), 12));
      }
      if (url.startsWith('/api/personal/changes/')) {
        return Promise.resolve(receipt(String(posted?.['commandId']), 11));
      }
      if (url.startsWith('/api/conversations?')) {
        const section = new URL(url, location.origin).searchParams.get('section');
        if (section === (archived ? 'archived' : 'recent')) {
          const row = { ...welcome, archived,
            archivePosition: archived ? 11 : firstReplyLost ? 0 : 12 };
          return Promise.resolve(list([row]));
        }
        return Promise.resolve(list([]));
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const archive = new WelcomeArchive(vi.fn(), fetcher);
    const signal = new AbortController().signal;
    await archive.load('saved-welcome', signal);
    expect(archive.row()).toEqual(welcome);

    await archive.change(signal);
    expect(archive.state()).toBe('unknown');
    expect(posted).toMatchObject({ welcomeId: 'saved-welcome', archived: true,
      expectedArchivePosition: 0 });
    expect(archivePosts).toBe(1);
    await archive.check(signal);
    expect(archive.row()?.archived).toBe(true);
    expect(archive.state()).toBe('ready');

    await archive.change(signal);
    expect(posted).toMatchObject({ welcomeId: 'saved-welcome', archived: false,
      expectedArchivePosition: 11 });
    expect(archive.row()?.archived).toBe(false);
    expect(archive.state()).toBe('ready');
  });

  it('shows a stale choice and clears protected rows on denial', async () => {
    let denied = false;
    const onDenied = vi.fn();
    const fetcher: typeof fetch = vi.fn((input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url === '/api/onboarding/welcome/archive') {
        return Promise.resolve(new Response('{}', { status: 409 }));
      }
      if (denied) return Promise.resolve(new Response('{}', { status: 403 }));
      return Promise.resolve(list([welcome]));
    });
    const archive = new WelcomeArchive(onDenied, fetcher);
    const signal = new AbortController().signal;
    await archive.load('saved-welcome', signal);
    await archive.change(signal);
    expect(archive.state()).toBe('changed');
    denied = true;
    await archive.load('saved-welcome', signal);
    expect(archive.row()).toBeNull();
    expect(onDenied).toHaveBeenCalledWith(403);
  });
});
