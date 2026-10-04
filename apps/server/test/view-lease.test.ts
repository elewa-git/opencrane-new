import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ViewCheckUnavailable } from '../src/computers/view-access.ts';
import { confirmAccess, ViewAccessUnconfirmed, ViewLease } from '../src/computers/view-lease.ts';

const computer = { computerId: 'desktop', generation: 1 };
function fakeTime() {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'],
  });
}
function events() {
  return {
    resumed: vi.fn(), renewed: vi.fn(), paused: vi.fn(), denied: vi.fn(), unconfirmed: vi.fn(),
  };
}
function pendingCheck() {
  let resolve!: (value: typeof computer) => void;
  let reject!: (error: Error) => void;
  function wait(succeed: typeof resolve, fail: typeof reject) {
    resolve = succeed;
    reject = fail;
  }
  const promise = new Promise(wait);
  function check() {
    return promise;
  }
  return { promise, resolve, reject, check };
}
function restoreTime() {
  vi.useRealTimers();
  vi.restoreAllMocks();
}
afterEach(restoreTime);

function leaseCases() {
  beforeEach(fakeTime);

  async function requiresResumeMargin(duration: number) {
    const notifications = events();
    let calls = 0;
    function check() {
      calls++;
      if (calls === 1) return Promise.resolve(computer);
      if (performance.now() < 1500) {
        return Promise.reject(new ViewCheckUnavailable('authorisation'));
      }
      function settle(resolve: (value: typeof computer) => void) {
        function succeed() {
          resolve(computer);
        }
        setTimeout(succeed, duration);
      }
      return new Promise(settle);
    }
    const lease = new ViewLease(check, computer, notifications);
    lease.start();
    await vi.advanceTimersByTimeAsync(1500);
    expect(notifications.paused).toHaveBeenCalledTimes(1);
    notifications.resumed.mockClear();
    await vi.advanceTimersByTimeAsync(duration);
    expect(lease.allows()).toBe(duration === 1000);
    expect(notifications.resumed).toHaveBeenCalledTimes(duration === 1000 ? 1 : 0);
    lease.stop();
  }
  it.each([1001, 1000])('requires 500 ms remaining before resuming (%i ms check)', requiresResumeMargin);

  async function ignoresLateSuccess() {
    const pending = pendingCheck();
    const notifications = events();
    const lease = new ViewLease(pending.check, computer, notifications);
    lease.start();
    // setSystemTime does not advance Vitest's performance clock. Move both without running timers.
    vi.setSystemTime(Date.now() + 1201);
    const clock = vi.spyOn(performance, 'now');
    clock.mockReturnValue(1201);
    pending.resolve(computer);
    await Promise.resolve();
    await Promise.resolve();
    expect(lease.allows()).toBe(false);
    expect(notifications.resumed).not.toHaveBeenCalled();
    lease.stop();
  }
  it('ignores a success processed 1,201 ms after its start before deadline timers run', ignoresLateSuccess);

  async function gatesSendsAtLapse() {
    const pending = pendingCheck();
    const notifications = events();
    const lease = new ViewLease(pending.check, computer, notifications);
    lease.start();
    pending.resolve(computer);
    await vi.advanceTimersByTimeAsync(0);
    vi.setSystemTime(Date.now() + 1500);
    const clock = vi.spyOn(performance, 'now');
    clock.mockReturnValue(1500);
    expect(lease.allows()).toBe(false);
    expect(lease.allows()).toBe(false);
    expect(notifications.paused).toHaveBeenCalledTimes(1);
    lease.stop();
  }
  it('gates sends after the lease ends without waiting for a timer', gatesSendsAtLapse);

  async function stopsFromPause() {
    const notifications = events();
    let calls = 0;
    function check() {
      calls++;
      if (calls === 1) return Promise.resolve(computer);
      return Promise.reject(new ViewCheckUnavailable('authorisation'));
    }
    const lease = new ViewLease(check, computer, notifications);
    function stopOnPause() {
      lease.stop();
    }
    notifications.paused.mockImplementation(stopOnPause);
    lease.start();
    await vi.advanceTimersByTimeAsync(1500);
    expect(notifications.paused).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  }
  it('leaves no timers when paused stops the lease', stopsFromPause);

  async function deniesAnOlderCheck() {
    const first = pendingCheck();
    const notifications = events();
    let calls = 0;
    function check() {
      calls++;
      if (calls === 1) return first.promise;
      return Promise.resolve(computer);
    }
    const lease = new ViewLease(check, computer, notifications);
    lease.start();
    await vi.advanceTimersByTimeAsync(250);
    expect(lease.allows()).toBe(true);
    first.reject(new Error('denied'));
    await vi.advanceTimersByTimeAsync(0);
    expect(notifications.denied).toHaveBeenCalledTimes(1);
    expect(lease.allows()).toBe(false);
    const eventCount = notifications.renewed.mock.calls.length;
    await vi.advanceTimersByTimeAsync(2000);
    expect(notifications.renewed).toHaveBeenCalledTimes(eventCount);
    expect(notifications.paused).not.toHaveBeenCalled();
  }
  it('stops once at the first denial even when a newer success exists', deniesAnOlderCheck);

  async function deniesChangedComputer() {
    const notifications = events();
    function check() {
      return Promise.resolve({ computerId: 'other', generation: 1 });
    }
    const lease = new ViewLease(check, computer, notifications);
    lease.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(notifications.denied).toHaveBeenCalledTimes(1);
    expect(lease.allows()).toBe(false);
  }
  it('treats a changed computer as a denial', deniesChangedComputer);

  async function endsUnconfirmedAccess() {
    const notifications = events();
    function check() {
      return Promise.reject(new ViewCheckUnavailable('authorisation'));
    }
    const lease = new ViewLease(check, computer, notifications);
    lease.start();
    await vi.advanceTimersByTimeAsync(9999);
    expect(notifications.unconfirmed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(notifications.unconfirmed).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  }
  it('reports unconfirmed access at 10 seconds, never before', endsUnconfirmedAccess);

  async function ignoresStoppedResults() {
    const pending = pendingCheck();
    const notifications = events();
    const lease = new ViewLease(pending.check, computer, notifications);
    lease.start();
    lease.stop();
    pending.resolve(computer);
    await vi.advanceTimersByTimeAsync(2000);
    expect(lease.allows()).toBe(false);
    for (const notify of Object.values(notifications)) expect(notify).not.toHaveBeenCalled();
  }
  it('ignores a success received after stop', ignoresStoppedResults);

  async function preservesLeaseSafety(seed: number) {
    const random = mulberry32(seed);
    const successes: { start: number; settled: number }[] = [];
    const starts: number[] = [];
    let pending = 0;
    let deniedAt: number | undefined;
    let stoppedAt: number | undefined;
    let denialEvents = 0;
    let outsideSince = 0;
    let latestUntil = -Infinity;
    let lastNotification = 0;
    function assertSafety() {
      const now = performance.now();
      expect(pending).toBeLessThanOrEqual(5);
      if (lease.allows(now)) {
        function coversNow(success: (typeof successes)[number]) {
          return success.settled <= now && success.settled - success.start <= 1200 &&
            success.start <= now && now < success.start + 1500;
        }
        expect(successes.some(coversNow)).toBe(true);
      }
      if (stoppedAt !== undefined) expect(lastNotification).toBeLessThanOrEqual(stoppedAt);
    }
    function check() {
      const start = performance.now();
      starts.push(start);
      pending++;
      const outcome = random();
      let milliseconds: number;
      if (outcome < 0.002) milliseconds = 20;
      else if (outcome < 0.55) milliseconds = 20 + Math.floor(random() * 1180);
      else if (outcome < 0.75) milliseconds = 1201 + Math.floor(random() * 400);
      else milliseconds = 20 + Math.floor(random() * 1281);
      function schedule(resolve: (value: typeof computer) => void, reject: (error: Error) => void) {
        function releaseSlot() {
          pending--;
        }
        setTimeout(releaseSlot, Math.min(milliseconds, 1200));
        function settle() {
          if (outcome < 0.002) {
            if (stoppedAt === undefined && milliseconds <= 1200) deniedAt = performance.now();
            reject(new Error('denied'));
          } else if (outcome < 0.75) {
            const settled = performance.now();
            successes.push({ start, settled });
            if (stoppedAt === undefined && settled - start <= 1200) {
              latestUntil = Math.max(latestUntil, start + 1500);
            }
            resolve(computer);
          } else reject(new ViewCheckUnavailable('authorisation'));
          assertSafety();
        }
        setTimeout(settle, milliseconds);
      }
      return new Promise(schedule);
    }
    function resumed() {
      lastNotification = performance.now();
      expect(latestUntil - lastNotification).toBeGreaterThanOrEqual(500);
    }
    function renewed() {
      lastNotification = performance.now();
    }
    function paused() {
      lastNotification = performance.now();
      outsideSince = latestUntil;
    }
    function denied() {
      lastNotification = performance.now();
      stoppedAt = lastNotification;
      denialEvents++;
      expect(lastNotification).toBe(deniedAt);
      expect(denialEvents).toBe(1);
    }
    function unconfirmed() {
      lastNotification = performance.now();
      stoppedAt = lastNotification;
      expect(lastNotification - outsideSince).toBeGreaterThanOrEqual(10_000);
      expect(lastNotification - outsideSince).toBeLessThanOrEqual(10_250);
    }
    const notifications = { resumed, renewed, paused, denied, unconfirmed };
    const lease = new ViewLease(check, computer, notifications);
    lease.start();
    for (let elapsed = 5; elapsed <= 30_000; elapsed += 5) {
      await vi.advanceTimersByTimeAsync(5);
      assertSafety();
      if (elapsed % 250 === 0 && stoppedAt === undefined) {
        expect(starts.at(-1)).toBe(elapsed);
      }
    }
    expect(denialEvents).toBe(deniedAt === undefined ? 0 : 1);
    lease.stop();
  }
  it.each(Array.from({ length: 20 }, seedNumber))(
    'preserves lease safety over 30 simulated seconds (seed %i)', preservesLeaseSafety, 30_000,
  );
}
describe('ViewLease', leaseCases);

async function stalledLoop() {
  const notifications = events();
  const next = pendingCheck();
  let calls = 0;
  function check() {
    calls++;
    if (calls === 2) return next.promise;
    return Promise.resolve(computer);
  }
  const lease = new ViewLease(check, computer, notifications);
  try {
    lease.start();
    await delay(270);
    expect(lease.allows()).toBe(true);
    const end = performance.now() + 1600;
    while (performance.now() < end) { /* Deliberately block timers and I/O. */ }
    next.resolve(computer);
    await Promise.resolve();
    await Promise.resolve();
    expect(notifications.renewed).not.toHaveBeenCalled();
    expect(notifications.resumed).toHaveBeenCalledTimes(1);
    expect(lease.allows()).toBe(false);
    expect(notifications.paused).toHaveBeenCalledTimes(1);
    await delay(300);
    expect(notifications.resumed).toHaveBeenCalledTimes(2);
  } finally {
    lease.stop();
  }
}
it('a stalled event loop earns no lease time', stalledLoop, 5000);

function admissionCases() {
  beforeEach(fakeTime);
  async function retriesSerially() {
    const starts: number[] = [];
    let inFlight = 0;
    function check() {
      starts.push(performance.now());
      inFlight++;
      expect(inFlight).toBe(1);
      const attempt = starts.length;
      function schedule(resolve: (value: typeof computer) => void, reject: (error: Error) => void) {
        function settle() {
          inFlight--;
          if (attempt < 3) reject(new ViewCheckUnavailable('authorisation'));
          else resolve(computer);
        }
        setTimeout(settle, 20);
      }
      return new Promise(schedule);
    }
    const result = confirmAccess(check);
    await vi.advanceTimersByTimeAsync(560);
    expect(await result).toEqual(computer);
    expect(starts).toEqual([0, 270, 540]);
  }
  it('retries unavailable checks one at a time, 250 ms after each failure', retriesSerially);
  async function stopsRetryingAtLimit() {
    const starts: number[] = [];
    function check() {
      starts.push(performance.now());
      function schedule(_resolve: (value: typeof computer) => void, reject: (error: Error) => void) {
        function fail() {
          reject(new ViewCheckUnavailable('authorisation'));
        }
        setTimeout(fail, 1250);
      }
      return new Promise(schedule);
    }
    const result = confirmAccess(check);
    const rejected = expect(result).rejects.toBeInstanceOf(ViewAccessUnconfirmed);
    await vi.advanceTimersByTimeAsync(5549);
    expect(starts).toEqual([0, 1450, 2900, 4350]);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
  }
  it('ends four timed-out checks at 5,550 ms without starting a fifth', stopsRetryingAtLimit);
  async function rethrowsDenial() {
    const error = new Error('denied');
    const check = vi.fn<() => Promise<typeof computer>>();
    check.mockRejectedValue(error);
    await expect(confirmAccess(check)).rejects.toBe(error);
    expect(check).toHaveBeenCalledTimes(1);
  }
  it('rethrows an explicit denial without retrying', rethrowsDenial);
  async function stalledRetry() {
    const check = vi.fn<() => Promise<typeof computer>>();
    const unavailable = new ViewCheckUnavailable('authorisation');
    check.mockRejectedValue(unavailable);
    const result = confirmAccess(check);
    const rejected = expect(result).rejects.toBeInstanceOf(ViewAccessUnconfirmed);
    await vi.advanceTimersByTimeAsync(0);
    const clock = vi.spyOn(performance, 'now');
    clock.mockReturnValue(5000);
    await vi.advanceTimersByTimeAsync(250);
    await rejected;
    expect(check).toHaveBeenCalledTimes(1);
  }
  it('does not start another retry after a stalled retry timer reaches the limit', stalledRetry);
}
describe('confirmAccess', admissionCases);

function seedNumber(_unused: unknown, index: number) {
  return index + 1;
}
function mulberry32(seed: number) {
  let state = seed;
  function next() {
    state += 0x6D2B79F5;
    let value = Math.imul(state ^ state >>> 15, state | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  }
  return next;
}
