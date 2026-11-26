import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { onboardingEntry } from './entry';

describe('where the signed-in member goes next', function entryTests() {
  beforeEach(function controlTime() {
    vi.useFakeTimers();
  });

  afterEach(function restoreTime() {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function reportsUnavailableEntry(status: number, kind: string) {
    const signal = new AbortController().signal;
    const request = vi.spyOn(globalThis, 'fetch');
    request.mockResolvedValue(new Response(null, { status }));
    await expect(onboardingEntry(signal)).resolves.toEqual({ kind });
    expect(request).toHaveBeenCalledTimes(1);
  }
  it.each([
    [204, 'disabled'],
    [401, 'signed-out'],
    [403, 'denied'],
  ])('distinguishes HTTP %i from the other entry states', reportsUnavailableEntry);

  async function waitsForMembership(status: number, justJoined: boolean) {
    const signal = new AbortController().signal;
    const request = vi.spyOn(globalThis, 'fetch');
    request.mockResolvedValueOnce(new Response(null, { status }));
    request.mockResolvedValueOnce(Response.json({ next: 'survey' }));
    const result = onboardingEntry(signal, justJoined);
    await vi.advanceTimersByTimeAsync(299);
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toEqual({ kind: 'destination', path: '/welcome/survey' });
    expect(request).toHaveBeenCalledTimes(2);
  }
  it.each([[425, false], [403, true]])('waits for membership after HTTP %i', waitsForMembership);

  async function cancelsDuringWait() {
    const controller = new AbortController();
    const request = vi.spyOn(globalThis, 'fetch');
    request.mockResolvedValue(new Response(null, { status: 425 }));
    const result = onboardingEntry(controller.signal);
    const cancelled = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await cancelled;
    expect(request).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  }
  it('cancels a pending membership check immediately', cancelsDuringWait, 1000);

  async function stopsAtDeadline() {
    const signal = new AbortController().signal;
    const request = vi.spyOn(globalThis, 'fetch');
    request.mockResolvedValue(new Response(null, { status: 425 }));
    const result = onboardingEntry(signal);
    const expired = expect(result).rejects.toMatchObject({ name: 'TimeoutError' });
    await vi.advanceTimersByTimeAsync(10_000);
    await expired;
    expect(request).toHaveBeenCalledTimes(34);
    expect(vi.getTimerCount()).toBe(0);
  }
  it('stops retrying at the entry deadline', stopsAtDeadline, 1000);
});
