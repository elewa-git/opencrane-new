import { afterEach, expect, it, vi } from 'vitest';
import { searchMembers } from './member-search-api';
import { fetchMember } from './members-api';

function restore() {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
}
afterEach(restore);

it('sends a bounded name search and checks status before reading the body', async () => {
  let bodyRead = false;
  const denied = { ok: false, status: 403,
    json: (): Promise<unknown> => { bodyRead = true; return Promise.resolve({}); } };
  const fetcher = vi.fn().mockResolvedValue(denied);
  vi.stubGlobal('fetch', fetcher);
  const query = 'x'.repeat(120);
  const result = await searchMembers(query, '', new AbortController().signal);
  expect(result).toEqual({ kind: 'access_changed', status: 403 });
  expect(bodyRead).toBe(false);
  const input: unknown = fetcher.mock.calls[0]?.[0];
  if (typeof input !== 'string') throw new Error('Expected a member search URL');
  const url = new URL(input, 'https://example.test');
  expect(url.searchParams.get('q')).toHaveLength(100);
  expect(url.searchParams.get('after')).toBe('');
  expect(url.searchParams.get('limit')).toBe('20');
});

function applying(): Promise<Response> {
  const body = JSON.stringify({ status: 'access_applying' });
  return Promise.resolve(new Response(body, { status: 425 }));
}

async function retriesAtIntervalsAndStops() {
  vi.useFakeTimers();
  const fetcher = vi.fn(applying);
  vi.stubGlobal('fetch', fetcher);
  const request = new AbortController();
  const loading = searchMembers('', '', request.signal);
  await vi.advanceTimersByTimeAsync(499);
  expect(fetcher).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(fetcher).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(4_500);
  expect(fetcher).toHaveBeenCalledTimes(11);
  expect(await loading).toEqual({ kind: 'unavailable', status: 425 });
  await vi.advanceTimersByTimeAsync(5_000);
  expect(fetcher).toHaveBeenCalledTimes(11);
}
it('waits between reads and stops after eleven applying replies', retriesAtIntervalsAndStops);

function controlledTimeout(ms: number): AbortSignal {
  const deadline = new AbortController();
  function expire() {
    deadline.abort(new DOMException('Read timed out', 'TimeoutError'));
  }
  globalThis.setTimeout(expire, ms);
  return deadline.signal;
}

function stalledFetch(_url: string, request: RequestInit): Promise<Response> {
  const signal = request.signal;
  if (!signal) {
    throw new Error('Expected a cancellable member read');
  }
  return new Promise<Response>(waitForAbort);

  function waitForAbort(_resolve: (response: Response) => void, reject: (cause: unknown) => void) {
    function abort() {
      reject(signal?.reason);
    }
    signal?.addEventListener('abort', abort, { once: true });
  }
}

async function abortsStalledDetail() {
  vi.useFakeTimers();
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(controlledTimeout);
  const fetcher = vi.fn(stalledFetch);
  vi.stubGlobal('fetch', fetcher);
  const request = new AbortController();
  const loading = fetchMember('alice', request.signal);
  const signal = fetcher.mock.calls[0]?.[1].signal;
  expect(signal).toBeDefined();
  await vi.advanceTimersByTimeAsync(9_999);
  expect(signal?.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(signal?.aborted).toBe(true);
  expect(await loading).toEqual({ kind: 'failed' });
  expect(fetcher).toHaveBeenCalledTimes(1);
}
it('aborts a stalled member detail read at ten seconds', abortsStalledDetail);

async function cancelsApplyingDetail() {
  vi.useFakeTimers();
  const fetcher = vi.fn(applying);
  vi.stubGlobal('fetch', fetcher);
  const request = new AbortController();
  const loading = fetchMember('alice', request.signal);
  await vi.advanceTimersByTimeAsync(0);
  request.abort();
  await vi.advanceTimersByTimeAsync(500);
  expect(await loading).toEqual({ kind: 'failed' });
  expect(fetcher).toHaveBeenCalledTimes(1);
}
it('cancels a delayed member detail retry', cancelsApplyingDetail);

async function ignoresOther425(body: string) {
  vi.useFakeTimers();
  const intermediary = new Response(body, { status: 425 });
  const fetcher = vi.fn().mockResolvedValueOnce(intermediary).mockImplementation(applying);
  vi.stubGlobal('fetch', fetcher);
  const request = new AbortController();
  const loading = fetchMember('alice', request.signal);
  await vi.advanceTimersByTimeAsync(500);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(await loading).toEqual({ kind: 'failed' });
}
it.each(['Too Early', '{"status":"try_later"}'])('does not retry an unrelated 425 (%s)',
  ignoresOther425);

async function readsDetailAfterExact425() {
  vi.useFakeTimers();
  const header = { memberId: 'alice', displayName: 'Alice', role: 'member',
    permissions: { changeRole: false, remove: false, manageOwnership: false } };
  const body = JSON.stringify(header);
  const success = new Response(body, { status: 200 });
  const applyingReply = await applying();
  const fetcher = vi.fn().mockResolvedValueOnce(applyingReply).mockResolvedValueOnce(success);
  vi.stubGlobal('fetch', fetcher);
  const request = new AbortController();
  const loading = fetchMember('alice', request.signal);
  await vi.advanceTimersByTimeAsync(500);
  expect(await loading).toEqual({ kind: 'ok', value: header });
  const urls = fetcher.mock.calls.map(readUrl);
  expect(urls).toEqual(['/api/members/alice', '/api/members/alice']);
}

function readUrl(call: unknown[]) {
  return call[0];
}
it('reads member details again after a documented applying reply', readsDetailAfterExact425);
