import { expect, it, vi } from 'vitest';
import { classifyStatus, fetchChange, followChange } from './groups-api';

it('classifies read and write statuses separately', () => {
  expect(classifyStatus(401, 'POST')).toBe('access_changed');
  expect(classifyStatus(403, 'GET')).toBe('access_changed');
  expect(classifyStatus(403, 'POST')).toBe('refused');
  expect(classifyStatus(400, 'POST')).toBe('invalid');
  expect(classifyStatus(409, 'POST')).toBe('conflict');
  expect(classifyStatus(503, 'GET')).toBe('unavailable');
});

it('marks a schema mismatch as unavailable', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"rows": []}')));
  const result = await fetchChange('group', 'command', new AbortController().signal);
  expect(result).toEqual({ kind: 'unavailable' });
  vi.unstubAllGlobals();
});

it('waits until both projections are current and records the check time', async () => {
  vi.useFakeTimers();
  const methods: (string | undefined)[] = [];
  const responses = [
    new Response(JSON.stringify({ status: 'appended', groupId: 'group', sequence: 1,
      changeId: 'change', projection: { content: 'current', iam: 'applying' } })),
    new Response(JSON.stringify({ status: 'appended', groupId: 'group', sequence: 1,
      changeId: 'change', projection: { content: 'current', iam: 'current' } })),
  ];
  const pending = vi.fn(nextResponse);
  vi.stubGlobal('fetch', pending);
  const resultPromise = followChange('group', 'command', new AbortController().signal);
  await vi.advanceTimersByTimeAsync(500);
  const result = await resultPromise;
  expect(result.kind).toBe('current');
  expect(methods.every(isReadMethod)).toBe(true);
  vi.useRealTimers();
  vi.unstubAllGlobals();

  function nextResponse(_input: RequestInfo | URL, options?: RequestInit): Promise<Response> {
    methods.push(options?.method);
    const next = responses.shift();
    if (!next) return Promise.reject(new Error('No fixture response remains'));
    return Promise.resolve(next);
  }
});

it('stops after twenty reads and uses the same command id each time', async () => {
  vi.useFakeTimers();
  const requests: string[] = [];
  vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
    requests.push(requestUrl(input));
    return Promise.resolve(new Response(JSON.stringify({ status: 'appended', groupId: 'group',
      sequence: 1, changeId: 'change',
      projection: { content: 'applying', iam: 'applying' } })));
  });
  const pending = followChange('group', 'command', new AbortController().signal);
  await vi.advanceTimersByTimeAsync(9500);
  const result = await pending;
  expect(result).toEqual({ kind: 'still_applying' });
  expect(requests).toHaveLength(20);
  expect(requests.every(hasCommandId)).toBe(true);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('keeps not-found and unavailable status reads distinct', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 404 })));
  await expect(followChange('group', 'command', new AbortController().signal))
    .resolves.toEqual({ kind: 'not_found' });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 503 })));
  await expect(followChange('group', 'command', new AbortController().signal))
    .resolves.toEqual({ kind: 'unavailable' });
  vi.unstubAllGlobals();
});

function hasCommandId(url: string): boolean {
  return url.endsWith('/changes/command');
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof Request) return input.url;
  return input.toString();
}

function isReadMethod(method: string | undefined): boolean {
  return method !== 'POST';
}
