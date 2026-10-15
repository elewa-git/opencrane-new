import { ViewDelivery } from './view-delivery.ts';
import { monotonicClock, ViewLease } from './view-lease.ts';
import { relativeLeaseExpiry, type viewTiming } from './view-timing.ts';
import type { ViewStopReason } from './view-sessions.ts';

type CheckPhase = 'post_audit' | 'renewal';
interface SessionSteps<Computer> {
  check(phase: CheckPhase, startedAt: number, validUntil: () => number | undefined): Promise<Computer>;
  openDesktop(): void;
  stop(reason: ViewStopReason): void;
}

export class LiveViewSession<Computer> {
  readonly lease: ViewLease<Computer>;
  readonly delivery: ViewDelivery;
  private readonly startedAt = monotonicClock.now();
  private readonly timing: ReturnType<typeof viewTiming>;
  private readonly steps: SessionSteps<Computer>;
  private readonly expiryTimer: ReturnType<typeof setTimeout>;
  private firstCheck = true;
  private desktopOpening = false;
  private stopped = false;

  constructor(
    computer: Computer, expiresAt: number,
    timing: ReturnType<typeof viewTiming>, steps: SessionSteps<Computer>,
  ) {
    this.timing = timing;
    this.steps = steps;
    const check = this.check.bind(this);
    const events = {
      resumed: this.resumed.bind(this), renewed: this.renewed.bind(this),
      paused: this.paused.bind(this), denied: this.denied.bind(this),
      unconfirmed: this.unconfirmed.bind(this),
    };
    this.lease = new ViewLease(check, computer, events);
    const stop = steps.stop.bind(steps);
    this.delivery = new ViewDelivery(this.lease, expiresAt, stop);
    const expired = this.expired.bind(this);
    const remainingMs = Math.max(0, expiresAt - monotonicClock.now());
    this.expiryTimer = setTimeout(expired, remainingMs);
  }

  start() {
    // Start after the audit append; only a later access check may open the desktop.
    this.lease.start();
  }

  isStopped() {
    return this.stopped;
  }

  stop(reason: ViewStopReason) {
    if (this.stopped) return false;
    this.stopped = true;
    const expiry = relativeLeaseExpiry(this.lease.validUntilAt(), this.startedAt);
    this.timing('stop', reason, 0, expiry);
    this.lease.stop();
    this.delivery.stop();
    clearTimeout(this.expiryTimer);
    return true;
  }

  private check() {
    let phase: CheckPhase = 'renewal';
    if (this.firstCheck) {
      this.firstCheck = false;
      phase = 'post_audit';
    }
    const validUntil = this.lease.validUntilAt.bind(this.lease);
    return this.steps.check(phase, this.startedAt, validUntil);
  }

  private resumed() {
    this.timing('lease_resume', 'ok');
    if (!this.desktopOpening) {
      this.desktopOpening = true;
      this.steps.openDesktop();
    }
    this.delivery.leaseResumed();
  }

  private renewed() {
    this.delivery.leaseRenewed();
  }

  private paused() {
    this.timing('lease_pause', 'unavailable');
    // Keep transports open to save a reconnect; ViewDelivery still refuses bytes.
    this.delivery.leasePaused();
  }

  private denied() {
    this.steps.stop('access_changed');
  }

  private unconfirmed() {
    this.steps.stop('unavailable');
  }

  private expired() {
    this.steps.stop('expired');
  }
}
