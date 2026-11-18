import { systemClock, type Clock } from '@opencrane/event-store';
import { createLogger } from '@opencrane/observability';

export interface ClockTimerOptions {
  clock: Clock;
  milliseconds: number;
  elapsed: () => void;
  unref?: boolean;
}

function systemTimer(milliseconds: number, elapsed: () => void, unref: boolean) {
  const timer = setTimeout(elapsed, milliseconds);
  if (unref) timer.unref();
  function cancel() {
    clearTimeout(timer);
  }
  return cancel;
}

/** Keep native timer references unchanged while allowing tests to advance deadline waits. */
export function clockTimer({ clock, milliseconds, elapsed, unref = false }: ClockTimerOptions) {
  const duration = Math.max(0, milliseconds);
  if (clock === systemClock) return systemTimer(duration, elapsed, unref);
  const controller = new AbortController();
  function failed(error: unknown) {
    if (controller.signal.aborted) return;
    const logger = createLogger('clock-timer');
    logger.error({ err: error }, 'Clock timer failed');
  }
  function cancel() {
    controller.abort();
  }
  function fire() {
    if (!controller.signal.aborted) elapsed();
  }
  const waiting = clock.sleep(duration, controller.signal);
  void waiting.then(fire, failed);
  return cancel;
}
