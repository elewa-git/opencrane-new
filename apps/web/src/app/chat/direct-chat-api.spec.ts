import { afterEach, expect, it, vi } from 'vitest';
import { fetchDirectConversations, fetchDirectHistory } from './direct-chat-api';

const row = {
  id: 'saved-group-row', position: 2, type: 'message.posted',
  time: '2026-10-22T09:00:00Z', data: { authorId: 'alice', text: 'Saved group message' },
};
const feed = { rows: [row], position: 2, generation: 1, computerState: 'not_applicable' };
const list = { rows: [{ conversationId: 'group', mode: 'group', createdBy: 'alice',
  createdAt: '2026-10-22T09:00:00Z', participantIds: ['alice', 'bob', 'carol'] }] };

function reply(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), { status });
}

function fakeServer(status: number, value: unknown, staysApplying = false) {
  let reads = 0;
  function fetchReply(): Promise<Response> {
    reads += 1;
    if (staysApplying || reads === 1) return Promise.resolve(reply(status, {}));
    return Promise.resolve(reply(200, value));
  }
  const fetcher = vi.fn(fetchReply);
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

function restoreClockAndServer() {
  vi.useRealTimers();
  vi.unstubAllGlobals();
}

async function loadsHistory(status: number): Promise<void> {
  vi.useFakeTimers();
  fakeServer(status, feed);
  const loading = fetchDirectHistory('group', new AbortController().signal);
  await vi.advanceTimersByTimeAsync(200);
  const result = await loading;
  expect(result).toMatchObject({ kind: 'ok', value: { rows: [row] } });
}

async function loadsList(status: number): Promise<void> {
  vi.useFakeTimers();
  fakeServer(status, list);
  const loading = fetchDirectConversations(new AbortController().signal);
  await vi.advanceTimersByTimeAsync(200);
  expect(await loading).toMatchObject({ kind: 'ok', value: list });
}

async function returnsFailure(status: number): Promise<void> {
  vi.useFakeTimers();
  const server = fakeServer(status, feed);
  const result = await fetchDirectHistory('group', new AbortController().signal);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(result.kind).not.toBe('ok');
  expect(server).toHaveBeenCalledTimes(1);
}

async function stopsRetrying(): Promise<void> {
  vi.useFakeTimers();
  const server = fakeServer(425, feed, true);
  const loading = fetchDirectHistory('group', new AbortController().signal);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(await loading).toMatchObject({ kind: 'access_applying' });
  const reads = server.mock.calls.length;
  await vi.advanceTimersByTimeAsync(10_000);
  expect(server).toHaveBeenCalledTimes(reads);
}

async function cancelsRetry(): Promise<void> {
  vi.useFakeTimers();
  const server = fakeServer(425, feed);
  const request = new AbortController();
  const loading = fetchDirectHistory('group', request.signal);
  await vi.advanceTimersByTimeAsync(0);
  request.abort();
  await vi.advanceTimersByTimeAsync(10_000);
  expect((await loading).kind).not.toBe('ok');
  expect(server).toHaveBeenCalledTimes(1);
}


afterEach(restoreClockAndServer);
it.each([425, 409])('loads saved group history after a temporary HTTP %i', loadsHistory);
it.each([425, 409])('loads the group list after a temporary HTTP %i', loadsList);
it.each([403, 404, 503])('returns HTTP %i without retrying', returnsFailure);
it('stops when the projection stays unavailable', stopsRetrying);
it('cancels a delayed retry before it can read another conversation', cancelsRetry);

function stalledServer() {
  const signals: AbortSignal[] = [];
  function fetchUntilAborted(_input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const signal = init?.signal;
    if (!signal) throw new Error('Expected a cancellable history request');
    signals.push(signal);
    return new Promise<Response>(holdFetch);

    function holdFetch(_resolve: (response: Response) => void, reject: (reason: unknown) => void) {
      if (!signal) throw new Error('Expected a cancellable history request');
      signal.addEventListener('abort', rejectOnAbort, { once: true });
      function rejectOnAbort(): void {
        reject(new DOMException('History request aborted', 'AbortError'));
      }
    }
  }
  const fetcher = vi.fn(fetchUntilAborted);
  vi.stubGlobal('fetch', fetcher);
  return { fetcher, signals };
}

async function cancelsRunningFetch(): Promise<void> {
  const { fetcher, signals } = stalledServer();
  const request = new AbortController();
  const loading = fetchDirectHistory('group', request.signal);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(signals[0]?.aborted).toBe(false);
  request.abort();
  expect(await loading).toEqual({ kind: 'unavailable' });
  expect(signals[0]?.aborted).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(1);
}

it('cancels a history fetch that is already waiting for a response', cancelsRunningFetch);

async function timesOutRunningFetch(): Promise<void> {
  const { fetcher, signals } = stalledServer();
  const timeout = vi.spyOn(AbortSignal, 'timeout');
  try {
    const loading = fetchDirectHistory('group', new AbortController().signal);
    expect(timeout).toHaveBeenCalledWith(10_000);
    expect(signals[0]?.aborted).toBe(false);
    expect(await loading).toEqual({ kind: 'unavailable' });
    expect(signals[0]?.aborted).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  } finally {
    timeout.mockRestore();
  }
}

it('aborts a stalled history fetch after ten seconds', timesOutRunningFetch, 15_000);
