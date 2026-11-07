import { onTestFinished, vi } from 'vitest';
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
  const dates = vi.spyOn(Date, 'now').mockImplementation(realDateNow);
  const originalVerify = context.verifyMemoryContext;
  function verify(...args: Parameters<typeof originalVerify>) {
    // Start each signed request at real arrival time, then control time during its checks.
    // Keep gateway-issued timestamps valid when several requests share this fixture.
    dates.mockReturnValue(realDateNow());
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
  }
  onTestFinished(restore);
  return { advance, resume, restore };
}
