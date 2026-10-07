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
  vi.stubGlobal('fetch', captureRequest(requests, receipt('ownership.stepped_down')));

  const result = await fetchOwnershipChange('command-2', new AbortController().signal);

  expect(result.kind).toBe('ok');
  expect(requests[0]?.method).toBeUndefined();
});

it('reads transfer status with GET and keeps the transfer reference', async () => {
  const requests: RequestInit[] = [];
  vi.stubGlobal('fetch', captureRequest(requests, receipt('ownership.transferred')));

  const result = await fetchOwnershipChange('transfer-command', new AbortController().signal);

  expect(result.kind).toBe('ok');
  expect(requests).toHaveLength(1);
  expect(requests[0]?.method).toBeUndefined();
});

it('keeps a lost reply as an unknown result', async () => {
  vi.stubGlobal('fetch', rejectRequest);
  const result = await sendOwnershipCommand({
    action: 'step_down', commandId: 'command-3', expectedSequence: 7,
  }, new AbortController().signal);
  expect(result).toEqual({ kind: 'unavailable' });
});

it('keeps a transfer lost reply as an unknown result', async () => {
  vi.stubGlobal('fetch', rejectRequest);
  const result = await sendTransfer('command-transfer-lost');
  expect(result).toEqual({ kind: 'unavailable' });
});

it('reports an expired session separately from an unknown send result', async () => {
  vi.stubGlobal('fetch', returnStatus(401));
  const result = await sendOwnershipCommand({
    action: 'transfer', commandId: 'command-4', expectedSequence: 7, successorId: 'member-2',
  }, new AbortController().signal);
  expect(result).toEqual({ kind: 'access_changed' });
});

it('reports a command rejected with 400 as not recorded', async () => {
  vi.stubGlobal('fetch', returnStatus(400));
  const result = await sendOwnershipCommand({
    action: 'transfer', commandId: 'command-5', expectedSequence: 7, successorId: 'member-2',
  }, new AbortController().signal);
  expect(result).toEqual({ kind: 'invalid' });
});

it.each(['concurrent_change', 'last_owner', 'already_owner', 'command_id_reused'])(
  'keeps the 409 reason %s from the ownership route', async (reason) => {
    vi.stubGlobal('fetch', returnReason(409, reason));
    const result = await sendTransfer('command-6');
    if (reason === 'last_owner') {
      expect(result).toEqual({ kind: 'last_owner', reason });
      return;
    }
    expect(result).toEqual({ kind: 'conflict', reason });
  },
);

it.each([
  'owner_required', 'owner_or_admin_required', 'access_changed',
  'active_membership_required', 'active_successor_required',
])('keeps the 403 reason %s from the ownership route', async (reason) => {
  vi.stubGlobal('fetch', returnReason(403, reason));
  const result = await sendTransfer('command-7');
  expect(result).toEqual({ kind: 'refused', reason });
});

it('keeps a 403 with no reason as a generic refusal', async () => {
  vi.stubGlobal('fetch', returnReason(403));
  expect(await sendTransfer('command-8')).toEqual({ kind: 'refused' });
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

function returnStatus(status: number): typeof fetch {
  return () => Promise.resolve(jsonResponse({}, status));
}

function returnReason(status: number, reason?: string): typeof fetch {
  const body = reason ? { status: 'refused', reason } : { status: 'refused' };
  return () => Promise.resolve(jsonResponse(body, status));
}

function sendTransfer(commandId: string) {
  return sendOwnershipCommand({ action: 'transfer', commandId, expectedSequence: 7,
    successorId: 'member-2' }, new AbortController().signal);
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
