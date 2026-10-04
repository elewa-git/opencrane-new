import { ViewCheckUnavailable, viewCheckMs } from './view-access.ts';

const LEASE_MS = 1500;
const CHECK_EVERY_MS = 250;
const MAX_CHECKS_IN_FLIGHT = 5;
const RESUME_MARGIN_MS = 500;
const NO_LEASE_LIMIT_MS = 10_000;
const ADMISSION_RETRY_LIMIT_MS = 5000;

export interface LeaseClock {
  now(): number;
}
function now() {
  // Wall-clock corrections must never lengthen permission to deliver desktop bytes.
  return performance.now();
}
export const monotonicClock: LeaseClock = { now };

export function deadline<T>(work: Promise<T>): Promise<T> {
  function wait(resolve: (result: T) => void, reject: (error: Error) => void) {
    function timedOut() {
      reject(new ViewCheckUnavailable('deadline'));
    }
    const timer = setTimeout(timedOut, viewCheckMs);
    function clearDeadline() {
      clearTimeout(timer);
    }
    const settled = work.then(resolve, reject);
    void settled.finally(clearDeadline);
  }
  return new Promise(wait);
}

export class ViewAccessUnconfirmed extends Error {}

function waitForRetry() {
  function wait(resolve: () => void) {
    setTimeout(resolve, CHECK_EVERY_MS);
  }
  return new Promise<void>(wait);
}

export async function confirmAccess<T>(check: () => Promise<T>, clock = monotonicClock) {
  const firstStartedAt = clock.now();
  while (clock.now() - firstStartedAt < ADMISSION_RETRY_LIMIT_MS) {
    try {
      return await deadline(check());
    } catch (error) {
      if (!(error instanceof ViewCheckUnavailable)) throw error;
      const nextAttemptAge = clock.now() - firstStartedAt + CHECK_EVERY_MS;
      if (nextAttemptAge >= ADMISSION_RETRY_LIMIT_MS) break;
      await waitForRetry();
    }
  }
  throw new ViewAccessUnconfirmed('Access checks did not answer in time');
}

interface LeaseEvents {
  resumed(): void;
  renewed(): void;
  paused(): void;
  denied(): void;
  unconfirmed(): void;
}

export class ViewLease<Computer> {
  private state: 'proving' | 'valid' | 'paused' | 'stopped' = 'proving';
  private validUntil = -Infinity;
  private outsideSince = 0;
  private inFlight = 0;
  private interval: ReturnType<typeof setInterval> | undefined;
  private lapseTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly check: () => Promise<Computer>;
  private readonly expected: Computer;
  private readonly events: LeaseEvents;
  private readonly clock: LeaseClock;

  constructor(
    check: () => Promise<Computer>, expected: Computer, events: LeaseEvents,
    clock = monotonicClock,
  ) {
    this.check = check;
    this.expected = expected;
    this.events = events;
    this.clock = clock;
  }

  start() {
    if (this.state === 'stopped' || this.interval !== undefined) return;
    this.outsideSince = this.clock.now();
    this.startCheck();
    if (this.isStopped()) return;
    const tick = this.tick.bind(this);
    this.interval = setInterval(tick, CHECK_EVERY_MS);
  }

  allows(now = this.clock.now()): boolean {
    if (this.state === 'valid' && now >= this.validUntil) this.lapse();
    return this.state === 'valid';
  }

  validUntilAt(): number | undefined {
    if (this.validUntil === -Infinity) return undefined;
    return this.validUntil;
  }

  stop() {
    this.state = 'stopped';
    clearInterval(this.interval);
    clearTimeout(this.lapseTimer);
  }

  private tick() {
    if (this.state === 'stopped') return;
    const now = this.clock.now();
    this.allows(now);
    if (this.isStopped()) return;
    if (this.state !== 'valid' && now - this.outsideSince >= NO_LEASE_LIMIT_MS) {
      this.stop();
      this.events.unconfirmed();
      return;
    }
    if (this.inFlight < MAX_CHECKS_IN_FLIGHT) this.startCheck();
  }

  private startCheck() {
    const startedAt = this.clock.now();
    this.inFlight++;
    void this.finishCheck(startedAt);
  }

  private async finishCheck(startedAt: number) {
    try {
      const computer = await deadline(this.check());
      this.acceptSuccess(startedAt, computer);
    } catch (error) {
      this.acceptFailure(error);
    } finally {
      this.inFlight--;
    }
  }

  private acceptSuccess(startedAt: number, computer: Computer) {
    if (this.state === 'stopped') return;
    if (JSON.stringify(computer) !== JSON.stringify(this.expected)) {
      this.deny();
      return;
    }
    const now = this.clock.now();
    // Expired lapse and deadline timers normally run before a waiting denial or stale success
    // is read. A success can still be processed late inside the same task, and it earns nothing.
    if (now - startedAt > viewCheckMs) return;
    this.allows(now);
    if (this.isStopped()) return;
    this.validUntil = Math.max(this.validUntil, startedAt + LEASE_MS);
    if (this.state === 'valid') {
      this.armLapseTimer();
      this.events.renewed();
    } else if (this.validUntil - now >= RESUME_MARGIN_MS) {
      this.state = 'valid';
      this.armLapseTimer();
      this.events.resumed();
    }
  }

  private acceptFailure(error: unknown) {
    if (this.state === 'stopped' || error instanceof ViewCheckUnavailable) return;
    this.deny();
  }

  private isStopped() {
    return this.state === 'stopped';
  }

  private armLapseTimer() {
    clearTimeout(this.lapseTimer);
    const lapse = this.checkLapse.bind(this);
    this.lapseTimer = setTimeout(lapse, this.validUntil - this.clock.now());
  }

  private checkLapse() {
    // Send-time checks also enforce this boundary when the timer cannot run promptly.
    this.allows();
    if (this.state === 'valid') this.armLapseTimer();
  }

  private lapse() {
    this.state = 'paused';
    this.outsideSince = this.validUntil;
    clearTimeout(this.lapseTimer);
    this.events.paused();
  }

  private deny() {
    this.stop();
    this.events.denied();
  }
}
