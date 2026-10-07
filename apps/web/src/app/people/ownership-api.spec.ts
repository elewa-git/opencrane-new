import { afterEach, expect, it, vi } from 'vitest';
import { fetchOwnershipChange, sendOwnershipCommand } from './ownership-api';

afterEach(() => vi.unstubAllGlobals());

it('sends an ownership transfer with the stream sequence and known successor id', async () => {
  const requests: RequestInit[] = [];
  vi.stubGlobal('fetch', captureRequest(requests, receipt('ownership.transferred')));

  const result = await sendOwnershipCommand({
    action: 'transfer', commandId: 'command-1', expectedSequence: 7, successorId: 'member-2',
  }, new AbortController().signal);

  expect(result.kind).toBe('ok');
  expect(requests).toHaveLength(1);
  const requestBody = requests[0]?.body;
  expect(typeof requestBody).toBe('string');
  if (typeof requestBody !== 'string') {
    throw new Error('Expected the ownership request body to be JSON text');
  }
  expect(JSON.parse(requestBody)).toEqual({
    action: 'transfer', commandId: 'command-1', expectedSequence: 7, successorId: 'member-2',
  });
});

it('reads status with GET and never resends the command', async () => {
  const requests: RequestInit[] = [];
  vi.stubGlobal('fetch', captureRequest(requests, receipt('ownership.transferred')));

  const result = await fetchOwnershipChange('command-2', new AbortController().signal);

  expect(result.kind).toBe('ok');
  expect(requests[0]?.method).toBeUndefined();
});

it('keeps a lost reply as an unknown result', async () => {
  vi.stubGlobal('fetch', rejectRequest);
  const result = await sendOwnershipCommand({
    action: 'transfer', commandId: 'command-3', expectedSequence: 7, successorId: 'member-2',
  }, new AbortController().signal);
  expect(result).toEqual({ kind: 'unavailable' });
});

function captureRequest(requests: RequestInit[], body: unknown): typeof fetch {
  return function returnReceipt(_input: RequestInfo | URL, options?: RequestInit) {
    requests.push(options ?? {});
    return Promise.resolve(jsonResponse(body));
  };
}

function rejectRequest(): Promise<Response> {
  return Promise.reject(new Error('The reply was lost'));
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function receipt(type: 'ownership.transferred' | 'ownership.stepped_down') {
  const data = type === 'ownership.transferred'
    ? { memberId: 'member-2', transferredBy: 'member-1' }
    : { memberId: 'member-1' };
  return {
    status: 'appended', commandId: 'command-1', changeId: 'event-1', sequence: 8,
    recordedAt: '2026-10-06T10:50:00.000Z', actorId: 'member-1', type, data,
  };
}
