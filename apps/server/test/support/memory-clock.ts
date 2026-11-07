import { onTestFinished, vi } from 'vitest';
import { decodeJwt } from 'jose';
import * as context from '../../../../libs/models/src/memory-context.ts';

// Control elapsed time without delaying service replies on the shared test host.
export function memoryClock() {
  let monotonic = performance.now();
  const realPerformanceNow = performance.now.bind(performance);
  const realDateNow = Date.now.bind(Date);
  function now() {
    return monotonic;
  }
  const times = vi.spyOn(performance, 'now').mockImplementation(now);
  let dates = vi.spyOn(Date, 'now').mockImplementation(realDateNow);
  const originalVerify = context.verifyMemoryContext;
  async function verify(...args: Parameters<typeof originalVerify>) {
    // Check each signed request within its own valid time window on a busy host.
    const claims = decodeJwt(args[0]);
    if (typeof claims.iat === 'number' && typeof claims.exp === 'number') {
      const checkedAt = (claims.iat + claims.exp) * 500;
      vi.useFakeTimers({ toFake: ['Date'], now: checkedAt });
      try {
        return await originalVerify(...args);
      } finally {
        vi.useRealTimers();
        dates = vi.spyOn(Date, 'now').mockReturnValue(checkedAt);
      }
    }
    return originalVerify(...args);
  }
  const contexts = vi.spyOn(context, 'verifyMemoryContext').mockImplementation(verify);
  function advance(milliseconds: number) {
    monotonic += milliseconds;
  }
  function resume() {
    times.mockImplementation(realPerformanceNow);
  }
  let restored = false;
  function restore() {
    if (restored) {
      return;
    }
    restored = true;
    contexts.mockRestore();
    times.mockRestore();
    dates.mockRestore();
    vi.useRealTimers();
  }
  onTestFinished(restore);
  return { advance, resume, restore };
}
